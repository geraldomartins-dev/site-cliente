'use strict';

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const {
    normalizarEmail, emailValido, validarSenha, hashSenha, verificarSenha,
    tokenAleatorio, hashToken, compararSegredo,
} = require('./lib/security');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = String(process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SETUP_CODE = process.env.SETUP_TOKEN || process.env.ADMIN_PASSWORD || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const COOKIE_NAME = 'clinica_session';
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 8));
const HORARIOS_VALIDOS = ['08:00','09:00','10:00','11:00','13:00','14:00','15:00','16:00','17:00'];
const MOTIVOS_VALIDOS = ['limpeza','dor','estetica','implante','orcamento','outro'];
const STATUS_VALIDOS = ['pendente','confirmada','faltou'];
const PAPEIS_VALIDOS = ['admin','dentista','recepcao'];

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

const origensPermitidas = ALLOWED_ORIGIN === '*'
    ? [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]
    : ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin(origin, cb) {
        if (!origin || origensPermitidas.includes(origin)) return cb(null, true);
        cb(new Error('Origem não permitida.'));
    },
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '12kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
});

const enviarHtmlSemCache = arquivo => (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', arquivo));
};
app.get('/PainelDentista.html', (_req, res) => res.redirect(302, '/painel'));
app.get('/SitePaciente.html', (_req, res) => res.redirect(302, '/'));
app.get('/', enviarHtmlSemCache('SitePaciente.html'));
app.get('/painel', enviarHtmlSemCache('PainelDentista.html'));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: NODE_ENV === 'production' ? '1h' : 0 }));

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'clinica_dentaria',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '-03:00',
});

const JANELAS = new Map();
const limpezaRateLimit = setInterval(() => {
    const agora = Date.now();
    for (const [chave, reg] of JANELAS.entries()) {
        if (agora - reg.inicio > 60 * 60 * 1000) JANELAS.delete(chave);
    }
}, 10 * 60 * 1000);
limpezaRateLimit.unref();

function rateLimit({ janela = 15 * 60 * 1000, max = 10, grupo = 'geral' } = {}) {
    return (req, res, next) => {
        const chave = `${grupo}:${req.ip}`;
        const agora = Date.now();
        const reg = JANELAS.get(chave) || { hits: 0, inicio: agora };
        if (agora - reg.inicio > janela) {
            JANELAS.set(chave, { hits: 1, inicio: agora });
            return next();
        }
        if (reg.hits >= max) {
            const segundos = Math.max(1, Math.ceil((janela - (agora - reg.inicio)) / 1000));
            res.setHeader('Retry-After', segundos);
            return res.status(429).json({ erro: `Muitas tentativas. Aguarde ${Math.ceil(segundos / 60)} min.` });
        }
        reg.hits += 1;
        JANELAS.set(chave, reg);
        next();
    };
}

function sanitizar(str, max = 150) {
    if (!str || typeof str !== 'string') return null;
    return str.trim().substring(0, max);
}

function dataEhPassada(dataStr) {
    const [ano, mes, dia] = String(dataStr).split('-').map(Number);
    const alvo = new Date(ano, mes - 1, dia);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    return alvo < hoje;
}

function dataEhFimDeSemana(dataStr) {
    const [ano, mes, dia] = String(dataStr).split('-').map(Number);
    const semana = new Date(ano, mes - 1, dia, 12).getDay();
    return semana === 0 || semana === 6;
}

function cookies(req) {
    return String(req.headers.cookie || '').split(';').reduce((acc, parte) => {
        const i = parte.indexOf('=');
        if (i > 0) acc[decodeURIComponent(parte.slice(0, i).trim())] = decodeURIComponent(parte.slice(i + 1).trim());
        return acc;
    }, {});
}

function definirCookieSessao(res, token) {
    const partes = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${SESSION_HOURS * 60 * 60}`,
    ];
    if (NODE_ENV === 'production') partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
}

function limparCookieSessao(res) {
    const partes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (NODE_ENV === 'production') partes.push('Secure');
    res.setHeader('Set-Cookie', partes.join('; '));
}

async function criarSessao(usuarioId, req, res) {
    const token = tokenAleatorio();
    const expiraEm = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await pool.execute(
        `INSERT INTO sessoes (usuario_id, token_hash, expira_em, user_agent)
         VALUES (?, ?, ?, ?)`,
        [usuarioId, hashToken(token), expiraEm, sanitizar(req.headers['user-agent'], 255)]
    );
    definirCookieSessao(res, token);
}

async function usuarioDaSessao(req) {
    const cookieToken = cookies(req)[COOKIE_NAME];
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    const token = cookieToken || bearer;
    if (!token) return null;
    const [[usuario]] = await pool.execute(
        `SELECT u.id, u.nome, u.email, u.papel, u.ativo, s.id AS sessao_id
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = ? AND s.expira_em > NOW() AND u.ativo = 1 LIMIT 1`,
        [hashToken(token)]
    );
    if (!usuario) return null;
    pool.execute(
        'UPDATE sessoes SET ultimo_uso_em = NOW() WHERE id = ? AND ultimo_uso_em < DATE_SUB(NOW(), INTERVAL 5 MINUTE)',
        [usuario.sessao_id]
    ).catch(() => {});
    return usuario;
}

async function autenticar(req, res, next) {
    try {
        const usuario = await usuarioDaSessao(req);
        if (!usuario) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
        req.usuario = usuario;
        next();
    } catch (err) {
        next(err);
    }
}

function exigirAdmin(req, res, next) {
    if (req.usuario?.papel !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem realizar esta ação.' });
    next();
}

const smtpConfigurado = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transportador = smtpConfigurado ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function enviarRecuperacao(usuario, link) {
    if (!transportador) return false;
    await transportador.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: usuario.email,
        subject: 'Redefinição de senha — Painel Dra. Naty',
        text: `Olá, ${usuario.nome}.\n\nUse o link abaixo para criar uma nova senha. Ele vale por 30 minutos:\n${link}\n\nSe você não pediu esta alteração, ignore este e-mail.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">Redefinição de senha</h2><p>Olá, ${usuario.nome}.</p><p>Use o botão abaixo para criar uma nova senha. O link vale por 30 minutos.</p><p><a href="${link}" style="display:inline-block;background:#0f766e;color:white;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Criar nova senha</a></p><p style="font-size:12px;color:#64748b">Se você não pediu esta alteração, ignore este e-mail.</p></div>`,
    });
    return true;
}

app.get('/api/health', async (_req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', banco: 'conectado', timestamp: new Date().toISOString() });
    } catch {
        res.status(503).json({ status: 'indisponivel', banco: 'desconectado' });
    }
});

app.get('/api/auth/status', async (_req, res, next) => {
    try {
        const [[r]] = await pool.query('SELECT COUNT(*) AS total FROM usuarios');
        res.json({ cadastroDisponivel: Number(r.total) === 0, smtpConfigurado });
    } catch (err) { next(err); }
});

app.post('/api/auth/cadastro', rateLimit({ max: 4, grupo: 'cadastro' }), async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 120);
    const email = normalizarEmail(req.body?.email);
    const senha = String(req.body?.senha || '');
    const codigo = String(req.body?.codigo || '');
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Informe seu nome completo.' });
    if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    const erroSenha = validarSenha(senha);
    if (erroSenha) return res.status(400).json({ erro: erroSenha });
    if (!SETUP_CODE || !compararSegredo(codigo, SETUP_CODE)) return res.status(403).json({ erro: 'Código de configuração incorreto.' });

    const conn = await pool.getConnection();
    let lockObtido = false;
    try {
        const [[lock]] = await conn.query("SELECT GET_LOCK('site_cliente_cadastro_inicial', 10) AS obtido");
        lockObtido = Number(lock.obtido) === 1;
        if (!lockObtido) return res.status(503).json({ erro: 'Cadastro ocupado. Tente novamente em instantes.' });
        const [[total]] = await conn.query('SELECT COUNT(*) AS total FROM usuarios');
        if (Number(total.total) > 0) return res.status(409).json({ erro: 'O cadastro inicial já foi concluído.' });
        const senhaHash = await hashSenha(senha);
        const [resultado] = await conn.execute(
            `INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?, ?, ?, 'admin')`,
            [nome, email, senhaHash]
        );
        await criarSessao(resultado.insertId, req, res);
        res.status(201).json({ usuario: { id: resultado.insertId, nome, email, papel: 'admin' } });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
        next(err);
    } finally {
        if (lockObtido) await conn.query("SELECT RELEASE_LOCK('site_cliente_cadastro_inicial')").catch(() => {});
        conn.release();
    }
});

app.post('/api/auth/login', rateLimit({ max: 5, grupo: 'login' }), async (req, res, next) => {
    try {
        const email = normalizarEmail(req.body?.email);
        const senha = String(req.body?.senha || '');
        if (!email || !senha) return res.status(400).json({ erro: 'Informe e-mail e senha.' });
        const [[usuario]] = await pool.execute('SELECT * FROM usuarios WHERE email = ? LIMIT 1', [email]);
        const valido = usuario?.ativo === 1 && await verificarSenha(senha, usuario?.senha_hash);
        if (!valido) {
            await new Promise(resolve => setTimeout(resolve, 450));
            return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
        }
        await pool.execute('UPDATE usuarios SET ultimo_login_em = NOW() WHERE id = ?', [usuario.id]);
        await criarSessao(usuario.id, req, res);
        JANELAS.delete(`login:${req.ip}`);
        res.json({ usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel } });
    } catch (err) { next(err); }
});

app.get('/api/auth/me', autenticar, (req, res) => {
    const { id, nome, email, papel } = req.usuario;
    res.json({ usuario: { id, nome, email, papel } });
});

app.post('/api/auth/logout', autenticar, async (req, res, next) => {
    try {
        await pool.execute('DELETE FROM sessoes WHERE id = ?', [req.usuario.sessao_id]);
        limparCookieSessao(res);
        res.status(204).send();
    } catch (err) { next(err); }
});

app.post('/api/auth/esqueci-senha', rateLimit({ max: 4, janela: 30 * 60 * 1000, grupo: 'recuperacao' }), async (req, res, next) => {
    const resposta = { mensagem: 'Se o e-mail estiver cadastrado, você receberá as instruções em instantes.' };
    try {
        const email = normalizarEmail(req.body?.email);
        if (!emailValido(email)) return res.status(202).json(resposta);
        const [[usuario]] = await pool.execute('SELECT id, nome, email FROM usuarios WHERE email = ? AND ativo = 1 LIMIT 1', [email]);
        if (!usuario) return res.status(202).json(resposta);
        const token = tokenAleatorio();
        await pool.execute('UPDATE recuperacoes_senha SET usado_em = NOW() WHERE usuario_id = ? AND usado_em IS NULL', [usuario.id]);
        await pool.execute(
            'INSERT INTO recuperacoes_senha (usuario_id, token_hash, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))',
            [usuario.id, hashToken(token)]
        );
        const link = `${APP_URL}/painel?reset=${encodeURIComponent(token)}`;
        try {
            const enviado = await enviarRecuperacao(usuario, link);
            if (!enviado && NODE_ENV !== 'production') resposta.linkDesenvolvimento = link;
        } catch (emailErr) {
            console.error('[EMAIL RECUPERAÇÃO]', emailErr.message);
            if (NODE_ENV !== 'production') resposta.linkDesenvolvimento = link;
        }
        res.status(202).json(resposta);
    } catch (err) { next(err); }
});

app.post('/api/auth/redefinir-senha', rateLimit({ max: 6, grupo: 'redefinicao' }), async (req, res, next) => {
    const token = String(req.body?.token || '');
    const senha = String(req.body?.senha || '');
    const erroSenha = validarSenha(senha);
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ erro: 'Link de recuperação inválido.' });
    if (erroSenha) return res.status(400).json({ erro: erroSenha });
    const senhaHash = await hashSenha(senha);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[registro]] = await conn.execute(
            `SELECT id, usuario_id FROM recuperacoes_senha
             WHERE token_hash = ? AND usado_em IS NULL AND expira_em > NOW() LIMIT 1 FOR UPDATE`,
            [hashToken(token)]
        );
        if (!registro) {
            await conn.rollback();
            return res.status(400).json({ erro: 'Este link expirou ou já foi utilizado.' });
        }
        await conn.execute('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [senhaHash, registro.usuario_id]);
        await conn.execute('UPDATE recuperacoes_senha SET usado_em = NOW() WHERE id = ?', [registro.id]);
        await conn.execute('DELETE FROM sessoes WHERE usuario_id = ?', [registro.usuario_id]);
        await conn.commit();
        limparCookieSessao(res);
        res.json({ mensagem: 'Senha redefinida. Você já pode entrar.' });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally { conn.release(); }
});

app.get('/api/usuarios', autenticar, exigirAdmin, async (_req, res, next) => {
    try {
        const [usuarios] = await pool.query(
            'SELECT id, nome, email, papel, ativo, ultimo_login_em, criado_em FROM usuarios ORDER BY nome'
        );
        res.json(usuarios);
    } catch (err) { next(err); }
});

app.post('/api/usuarios', autenticar, exigirAdmin, async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 120);
    const email = normalizarEmail(req.body?.email);
    const senha = String(req.body?.senha || '');
    const papel = PAPEIS_VALIDOS.includes(req.body?.papel) ? req.body.papel : 'dentista';
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Informe o nome.' });
    if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    const erroSenha = validarSenha(senha);
    if (erroSenha) return res.status(400).json({ erro: erroSenha });
    try {
        const senhaHash = await hashSenha(senha);
        const [r] = await pool.execute(
            'INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?, ?, ?, ?)',
            [nome, email, senhaHash, papel]
        );
        res.status(201).json({ id: r.insertId, nome, email, papel, ativo: 1 });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
        next(err);
    }
});

app.patch('/api/usuarios/:id/status', autenticar, exigirAdmin, async (req, res, next) => {
    const id = Number(req.params.id);
    const ativo = req.body?.ativo ? 1 : 0;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Usuário inválido.' });
    if (id === req.usuario.id && !ativo) return res.status(400).json({ erro: 'Você não pode desativar sua própria conta.' });
    try {
        const [r] = await pool.execute('UPDATE usuarios SET ativo = ? WHERE id = ?', [ativo, id]);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        if (!ativo) await pool.execute('DELETE FROM sessoes WHERE usuario_id = ?', [id]);
        res.json({ mensagem: ativo ? 'Usuário ativado.' : 'Usuário desativado.' });
    } catch (err) { next(err); }
});

app.get('/api/clientes', autenticar, async (_req, res, next) => {
    try {
        const [clientes] = await pool.query(
            `SELECT c.id, c.nome, c.telefone, c.email, c.data_nascimento, c.criado_em,
                    COUNT(a.id) AS totalConsultas, MAX(a.data) AS ultimaConsulta
             FROM clientes c LEFT JOIN agendamentos a ON a.cliente_id = c.id
             GROUP BY c.id ORDER BY c.nome`
        );
        res.json(clientes);
    } catch (err) { next(err); }
});

app.post('/api/clientes', autenticar, async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 120);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Informe o nome do paciente.' });
    if (!/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Informe telefone com DDD.' });
    if (email && !emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    try {
        const [r] = await pool.execute('INSERT INTO clientes (nome, telefone, email) VALUES (?, ?, ?)', [nome, telefone, email]);
        res.status(201).json({ id: r.insertId, nome, telefone, email });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Já existe um paciente com este telefone.' });
        next(err);
    }
});

app.put('/api/clientes/:id', autenticar, async (req, res, next) => {
    const id = Number(req.params.id);
    const nome = sanitizar(req.body?.nome, 120);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Paciente inválido.' });
    if (!nome || !/^\d{10,11}$/.test(telefone) || (email && !emailValido(email))) return res.status(400).json({ erro: 'Revise nome, telefone e e-mail.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [r] = await conn.execute('UPDATE clientes SET nome = ?, telefone = ?, email = ? WHERE id = ?', [nome, telefone, email, id]);
        if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ erro: 'Paciente não encontrado.' }); }
        await conn.execute('UPDATE agendamentos SET nome = ?, telefone = ? WHERE cliente_id = ?', [nome.slice(0, 100), telefone, id]);
        await conn.commit();
        res.json({ id, nome, telefone, email });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este telefone já pertence a outro paciente.' });
        next(err);
    } finally { conn.release(); }
});

app.get('/api/horarios-disponiveis', async (req, res, next) => {
    const { data } = req.query;
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ erro: 'Data inválida. Use AAAA-MM-DD.' });
    if (dataEhPassada(data) || dataEhFimDeSemana(data)) return res.json({ data, disponiveis: [], todos: HORARIOS_VALIDOS });
    try {
        const [ocupados] = await pool.execute(
            `SELECT horario FROM agendamentos WHERE data = ? AND status != 'faltou'`, [data]
        );
        const set = new Set(ocupados.map(r => r.horario));
        res.json({ data, disponiveis: HORARIOS_VALIDOS.filter(h => !set.has(h)), todos: HORARIOS_VALIDOS });
    } catch (err) { next(err); }
});

app.post('/api/agendamentos', rateLimit({ max: 8, janela: 10 * 60 * 1000, grupo: 'agendamento' }), async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 100);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const { data, horario, preferencia } = req.body || {};
    const observacoes = sanitizar(req.body?.observacoes, 1000);
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Nome inválido.' });
    if (!/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Telefone inválido. Informe DDD + número.' });
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || dataEhPassada(data)) return res.status(400).json({ erro: 'Escolha uma data futura válida.' });
    if (dataEhFimDeSemana(data)) return res.status(400).json({ erro: 'Atendemos de segunda a sexta.' });
    if (!HORARIOS_VALIDOS.includes(horario)) return res.status(400).json({ erro: 'Horário inválido.' });
    if (preferencia && !MOTIVOS_VALIDOS.includes(preferencia)) return res.status(400).json({ erro: 'Motivo de consulta inválido.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [conflito] = await conn.execute(
            `SELECT id FROM agendamentos WHERE data = ? AND horario = ? AND status != 'faltou' LIMIT 1 FOR UPDATE`,
            [data, horario]
        );
        if (conflito.length) { await conn.rollback(); return res.status(409).json({ erro: 'Horário já ocupado. Escolha outro.' }); }
        await conn.execute(
            `INSERT INTO clientes (nome, telefone) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE nome = VALUES(nome)`,
            [nome, telefone]
        );
        const [[cliente]] = await conn.execute('SELECT id FROM clientes WHERE telefone = ? LIMIT 1', [telefone]);
        const [r] = await conn.execute(
            `INSERT INTO agendamentos (cliente_id, nome, telefone, data, horario, preferencia, observacoes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente')`,
            [cliente.id, nome, telefone, data, horario, preferencia || null, observacoes]
        );
        await conn.commit();
        res.status(201).json({ id: r.insertId, mensagem: 'Solicitação registrada.' });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally { conn.release(); }
});

app.get('/api/agendamentos', autenticar, async (_req, res, next) => {
    try {
        const [linhas] = await pool.query('SELECT * FROM agendamentos ORDER BY data DESC, horario ASC');
        res.json(linhas);
    } catch (err) { next(err); }
});

app.delete('/api/agendamentos/:id', autenticar, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    try {
        const [r] = await pool.execute('DELETE FROM agendamentos WHERE id = ?', [id]);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
        res.status(204).send();
    } catch (err) { next(err); }
});

app.put('/api/agendamentos/:id/status', autenticar, async (req, res, next) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
    try {
        const [r] = await pool.execute('UPDATE agendamentos SET status = ? WHERE id = ?', [status, id]);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
        res.json({ mensagem: 'Status atualizado.' });
    } catch (err) { next(err); }
});

app.put('/api/agendamentos/:id/financeiro', autenticar, async (req, res, next) => {
    const id = Number(req.params.id);
    const { valor, pago } = req.body || {};
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    if (valor === undefined && pago === undefined) return res.status(400).json({ erro: 'Informe valor ou situação.' });
    if (valor !== undefined && (!Number.isFinite(Number(valor)) || Number(valor) < 0)) return res.status(400).json({ erro: 'Valor inválido.' });
    try {
        const campos = [], params = [];
        if (valor !== undefined) { campos.push('valor = ?'); params.push(Number(valor)); }
        if (pago !== undefined) { campos.push('pago = ?'); params.push(pago ? 1 : 0); }
        params.push(id);
        const [r] = await pool.execute(`UPDATE agendamentos SET ${campos.join(', ')} WHERE id = ?`, params);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
        res.json({ mensagem: 'Dados financeiros atualizados.' });
    } catch (err) { next(err); }
});

app.get('/api/financeiro/resumo', autenticar, async (req, res, next) => {
    const mesParam = req.query.mes;
    let ano, mes;
    if (mesParam && /^\d{4}-\d{2}$/.test(mesParam)) [ano, mes] = mesParam.split('-').map(Number);
    else { const agora = new Date(); ano = agora.getFullYear(); mes = agora.getMonth() + 1; }
    if (mes < 1 || mes > 12) return res.status(400).json({ erro: 'Mês inválido.' });
    const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const fim = `${ano}-${String(mes).padStart(2, '0')}-${new Date(ano, mes, 0).getDate()}`;
    try {
        const [[totais]] = await pool.execute(
            `SELECT COUNT(*) AS totalAgendamentos,
                    SUM(CASE WHEN status = 'confirmada' THEN 1 ELSE 0 END) AS totalCompareceram,
                    SUM(CASE WHEN status = 'faltou' THEN 1 ELSE 0 END) AS totalFaltaram,
                    COALESCE(SUM(valor), 0) AS receitaTotal,
                    COALESCE(SUM(CASE WHEN pago = 1 THEN valor ELSE 0 END), 0) AS receitaRecebida,
                    COALESCE(SUM(CASE WHEN pago = 0 AND valor IS NOT NULL AND status != 'faltou' THEN valor ELSE 0 END), 0) AS receitaPendente
             FROM agendamentos WHERE data BETWEEN ? AND ?`,
            [inicio, fim]
        );
        res.json({ periodo: { inicio, fim }, ...totais });
    } catch (err) { next(err); }
});

app.use((_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ erro: 'O conteúdo enviado não é um JSON válido.' });
    }
    console.error('[ERRO]', err.code || err.message);
    if (err.message === 'Origem não permitida.') return res.status(403).json({ erro: 'Origem não permitida.' });
    res.status(500).json({ erro: 'Não foi possível concluir a operação.' });
});

async function iniciar() {
    const conn = await pool.getConnection();
    try {
        const [[estrutura]] = await conn.query(
            `SELECT COUNT(*) AS total FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN ('usuarios','clientes','sessoes','recuperacoes_senha')`
        );
        if (Number(estrutura.total) < 4) throw new Error('Estrutura do banco ausente. Execute: npm run migrate');
    } finally { conn.release(); }
    const limpezaSessoes = setInterval(() => {
        pool.query('DELETE FROM sessoes WHERE expira_em <= NOW()').catch(() => {});
        pool.query('DELETE FROM recuperacoes_senha WHERE expira_em < DATE_SUB(NOW(), INTERVAL 1 DAY)').catch(() => {});
    }, 60 * 60 * 1000);
    limpezaSessoes.unref();
    app.listen(PORT, () => {
        console.log(`Servidor Site Cliente ativo em ${APP_URL}`);
        console.log(`Banco conectado; e-mail de recuperação: ${smtpConfigurado ? 'configurado' : 'modo local'}.`);
    });
}

iniciar().catch(err => {
    console.error('Falha ao iniciar:', err.message);
    process.exit(1);
});
