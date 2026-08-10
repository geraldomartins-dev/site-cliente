'use strict';

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const {
    normalizarEmail, emailValido, validarSenha, hashSenha, verificarSenha, precisaRehash,
    tokenAleatorio, hashToken, compararSegredo,
} = require('./lib/security');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = String(process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SETUP_CODE = process.env.SETUP_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const COOKIE_NAME = 'clinica_session';
const CSRF_COOKIE_NAME = 'clinica_csrf';
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 8));
const HORARIOS_VALIDOS = String(process.env.SCHEDULE_SLOTS || '08:00,09:00,10:00,11:00,13:00,14:00,15:00,16:00,17:00')
    .split(',').map(s => s.trim()).filter(h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h));
const MOTIVOS_VALIDOS = ['limpeza','dor','estetica','implante','orcamento','outro'];
const STATUS_VALIDOS = ['pendente','confirmada','concluida','faltou','cancelada'];
const STATUS_ATIVOS = ['pendente','confirmada'];
const PAPEIS_VALIDOS = ['admin','dentista','recepcao'];
const CLINIC_NAME = sanitizar(process.env.CLINIC_NAME, 120) || 'Clínica Dra. Naty';
const NOTIFICATION_EMAIL = normalizarEmail(process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER);
const CLINIC_WHATSAPP = String(process.env.CLINIC_WHATSAPP || '554396941226').replace(/\D/g, '');
const CLINIC_PHONE_DISPLAY = sanitizar(process.env.CLINIC_PHONE_DISPLAY, 40) || '(43) 9694-1226';
const CLINIC_INSTAGRAM = sanitizar(process.env.CLINIC_INSTAGRAM, 80) || 'natylapicoloto';
const CLINIC_ADDRESS = sanitizar(process.env.CLINIC_ADDRESS, 180) || 'Centro — Jacarezinho, PR';
const CLINIC_CRO = sanitizar(process.env.CLINIC_CRO, 40) || '';

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
    allowedHeaders: ['Content-Type','Authorization','X-CSRF-Token'],
}));
app.use(express.json({ limit: '12kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
});

const enviarHtmlSemCache = arquivo => (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', arquivo));
};
app.get('/PainelDentista.html', (_req, res) => res.redirect(302, '/painel'));
app.get('/SitePaciente.html', (_req, res) => res.redirect(302, '/'));
app.get('/Privacidade.html', (_req, res) => res.redirect(302, '/privacidade'));
app.get('/', enviarHtmlSemCache('SitePaciente.html'));
app.get('/painel', enviarHtmlSemCache('PainelDentista.html'));
app.get('/privacidade', enviarHtmlSemCache('Privacidade.html'));
app.get('/config.js', (_req, res) => {
    const configuracao = {
        nome: CLINIC_NAME,
        whatsapp: CLINIC_WHATSAPP,
        whatsappExibicao: CLINIC_PHONE_DISPLAY,
        whatsappUrl: `https://wa.me/${CLINIC_WHATSAPP}`,
        instagram: CLINIC_INSTAGRAM,
        instagramUrl: `https://www.instagram.com/${encodeURIComponent(CLINIC_INSTAGRAM)}`,
        endereco: CLINIC_ADDRESS,
        cro: CLINIC_CRO,
    };
    res.type('application/javascript').setHeader('Cache-Control', 'public, max-age=300');
    res.send(`window.CLINICA_CONFIG=${JSON.stringify(configuracao).replace(/</g, '\\u003c')};`);
});
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

function dataValida(dataStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataStr || ''))) return false;
    const [ano, mes, dia] = String(dataStr).split('-').map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

function dataEhHojeOuPassada(dataStr) {
    const [ano, mes, dia] = String(dataStr).split('-').map(Number);
    const alvo = new Date(ano, mes - 1, dia);
    const amanha = new Date();
    amanha.setHours(0, 0, 0, 0);
    amanha.setDate(amanha.getDate() + 1);
    return alvo < amanha;
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

function escaparHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caractere => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[caractere]);
}

function dataIso(valor) {
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    return String(valor || '').split('T')[0].slice(0, 10);
}

function campoCsv(valor) {
    let texto = valor == null ? '' : String(valor);
    if (/^[=+\-@]/.test(texto)) texto = `'${texto}`;
    return `"${texto.replace(/"/g, '""')}"`;
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

function definirCookieCsrf(res, token) {
    const partes = [
        `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'SameSite=Strict',
        `Max-Age=${SESSION_HOURS * 60 * 60}`,
    ];
    if (NODE_ENV === 'production') partes.push('Secure');
    res.append('Set-Cookie', partes.join('; '));
}

function limparCookieSessao(res) {
    const partes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (NODE_ENV === 'production') partes.push('Secure');
    res.append('Set-Cookie', partes.join('; '));
    const csrf = [`${CSRF_COOKIE_NAME}=`, 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
    if (NODE_ENV === 'production') csrf.push('Secure');
    res.append('Set-Cookie', csrf.join('; '));
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
    definirCookieCsrf(res, tokenAleatorio());
}

async function usuarioDaSessao(req) {
    const cookieToken = cookies(req)[COOKIE_NAME];
    const aceitarBearer = NODE_ENV === 'test' || process.env.ALLOW_BEARER_AUTH === '1';
    const bearer = aceitarBearer ? String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] : null;
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

function exigirPapeis(...papeis) {
    return (req, res, next) => {
        if (!papeis.includes(req.usuario?.papel)) return res.status(403).json({ erro: 'Seu perfil não tem permissão para esta ação.' });
        next();
    };
}

function protegerCsrf(req, res, next) {
    const tokenCookie = cookies(req)[CSRF_COOKIE_NAME];
    const tokenCabecalho = String(req.headers['x-csrf-token'] || '');
    if (!tokenCookie || !tokenCabecalho || !compararSegredo(tokenCookie, tokenCabecalho)) {
        return res.status(403).json({ erro: 'A página perdeu a validação de segurança. Atualize e tente novamente.' });
    }
    next();
}

async function registrarAuditoria(req, acao, entidade, entidadeId, detalhes = null, conn = pool) {
    try {
        await conn.execute(
            `INSERT INTO auditoria (usuario_id, acao, entidade, entidade_id, detalhes, ip)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.usuario?.id || null, acao, entidade, entidadeId == null ? null : String(entidadeId), detalhes ? JSON.stringify(detalhes) : null, sanitizar(req.ip, 64)]
        );
    } catch (err) {
        console.error('[AUDITORIA]', err.code || err.message);
    }
}

const senhaSmtp = String(process.env.SMTP_PASS || '');
const senhaSmtpNormalizada = String(process.env.SMTP_HOST || '').includes('gmail.com') ? senhaSmtp.replace(/\s/g, '') : senhaSmtp;
const smtpConfigurado = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && senhaSmtpNormalizada);
const transportador = smtpConfigurado ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: senhaSmtpNormalizada },
    requireTLS: Number(process.env.SMTP_PORT || 587) === 587,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
}) : null;

async function enviarEmail({ para, assunto, texto, html }) {
    if (!transportador) throw new Error('SMTP não configurado.');
    await transportador.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: para,
        subject: assunto,
        text: texto,
        html,
    });
}

async function enviarRecuperacao(usuario, link, convite = false) {
    const nome = escaparHtml(usuario.nome);
    const url = escaparHtml(link);
    const titulo = convite ? 'Crie seu acesso ao painel' : 'Redefinição de senha';
    const acao = convite ? 'Criar minha senha' : 'Criar nova senha';
    await enviarEmail({
        para: usuario.email,
        assunto: `${titulo} — ${CLINIC_NAME}`,
        texto: `Olá, ${usuario.nome}.\n\n${convite ? 'Você recebeu acesso ao painel da clínica.' : 'Recebemos uma solicitação para alterar sua senha.'}\nUse o link abaixo em até 30 minutos:\n${link}\n\nSe você não reconhece esta mensagem, ignore o e-mail.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">${titulo}</h2><p>Olá, ${nome}.</p><p>${convite ? 'Você recebeu acesso ao painel da clínica.' : 'Recebemos uma solicitação para alterar sua senha.'} O link abaixo vale por 30 minutos.</p><p><a href="${url}" style="display:inline-block;background:#0f766e;color:white;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">${acao}</a></p><p style="font-size:12px;color:#64748b">Se você não reconhece esta mensagem, ignore o e-mail.</p></div>`,
    });
}

async function enviarEmailAgendamento(agendamento, tipo = 'recebido') {
    if (!transportador || !agendamento.email) return false;
    const data = new Date(`${dataIso(agendamento.data)}T12:00:00`).toLocaleDateString('pt-BR');
    const titulos = {
        recebido: 'Recebemos sua solicitação',
        confirmada: 'Sua consulta foi confirmada',
        cancelada: 'Sua consulta foi cancelada',
        concluida: 'Atendimento concluído',
    };
    const titulo = titulos[tipo] || 'Atualização da sua consulta';
    const observacao = tipo === 'recebido'
        ? 'Nossa equipe ainda confirmará os detalhes pelo WhatsApp ou e-mail.'
        : tipo === 'cancelada'
            ? 'Se precisar de outro horário, faça uma nova solicitação pelo site ou fale conosco.'
            : 'Se precisar falar com a clínica, responda a este e-mail.';
    await enviarEmail({
        para: agendamento.email,
        assunto: `${titulo} — ${CLINIC_NAME}`,
        texto: `Olá, ${agendamento.nome}.\n\n${titulo}.\nData: ${data}\nHorário: ${agendamento.horario}\nProtocolo: ${agendamento.protocolo || `AG-${agendamento.id}`}\n\n${observacao}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">${escaparHtml(titulo)}</h2><p>Olá, ${escaparHtml(agendamento.nome)}.</p><p><strong>Data:</strong> ${escaparHtml(data)}<br><strong>Horário:</strong> ${escaparHtml(agendamento.horario)}<br><strong>Protocolo:</strong> ${escaparHtml(agendamento.protocolo || `AG-${agendamento.id}`)}</p><p>${escaparHtml(observacao)}</p></div>`,
    });
    return true;
}

async function notificarClinicaNovoAgendamento(agendamento) {
    if (!transportador || !NOTIFICATION_EMAIL) return false;
    await enviarEmail({
        para: NOTIFICATION_EMAIL,
        assunto: `Novo pedido de agendamento — ${agendamento.nome}`,
        texto: `Novo pedido pelo site.\nPaciente: ${agendamento.nome}\nTelefone: ${agendamento.telefone}\nData: ${dataIso(agendamento.data)}\nHorário: ${agendamento.horario}\nMotivo: ${agendamento.preferencia || 'não informado'}\nProtocolo: ${agendamento.protocolo}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">Novo pedido de agendamento</h2><p><strong>Paciente:</strong> ${escaparHtml(agendamento.nome)}<br><strong>Telefone:</strong> ${escaparHtml(agendamento.telefone)}<br><strong>Data:</strong> ${escaparHtml(dataIso(agendamento.data))}<br><strong>Horário:</strong> ${escaparHtml(agendamento.horario)}<br><strong>Motivo:</strong> ${escaparHtml(agendamento.preferencia || 'não informado')}<br><strong>Protocolo:</strong> ${escaparHtml(agendamento.protocolo)}</p><p>Abra o painel para confirmar ou ajustar.</p></div>`,
    });
    return true;
}

async function aguardarTempoMinimo(inicio, minimoMs = 700) {
    const restante = minimoMs - (Date.now() - inicio);
    if (restante > 0) await new Promise(resolve => setTimeout(resolve, restante));
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
        if (precisaRehash(usuario.senha_hash)) {
            await pool.execute('UPDATE usuarios SET senha_hash = ?, ultimo_login_em = NOW() WHERE id = ?', [await hashSenha(senha), usuario.id]);
        } else {
            await pool.execute('UPDATE usuarios SET ultimo_login_em = NOW() WHERE id = ?', [usuario.id]);
        }
        await criarSessao(usuario.id, req, res);
        JANELAS.delete(`login:${req.ip}`);
        res.json({ usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, papel: usuario.papel } });
    } catch (err) { next(err); }
});

app.get('/api/auth/me', autenticar, (req, res) => {
    if (!cookies(req)[CSRF_COOKIE_NAME]) definirCookieCsrf(res, tokenAleatorio());
    const { id, nome, email, papel } = req.usuario;
    res.json({ usuario: { id, nome, email, papel } });
});

app.post('/api/auth/logout', autenticar, protegerCsrf, async (req, res, next) => {
    try {
        await pool.execute('DELETE FROM sessoes WHERE id = ?', [req.usuario.sessao_id]);
        limparCookieSessao(res);
        res.status(204).send();
    } catch (err) { next(err); }
});

app.post('/api/auth/esqueci-senha', rateLimit({ max: 4, janela: 30 * 60 * 1000, grupo: 'recuperacao' }), async (req, res, next) => {
    const resposta = { mensagem: 'Se o e-mail estiver cadastrado, você receberá as instruções em instantes.' };
    const inicio = Date.now();
    try {
        if (!smtpConfigurado) return res.status(503).json({ erro: 'A recuperação por e-mail ainda não foi configurada pela clínica.' });
        const email = normalizarEmail(req.body?.email);
        if (!emailValido(email)) { await aguardarTempoMinimo(inicio); return res.status(202).json(resposta); }
        const [[usuario]] = await pool.execute('SELECT id, nome, email FROM usuarios WHERE email = ? AND ativo = 1 LIMIT 1', [email]);
        if (!usuario) { await aguardarTempoMinimo(inicio); return res.status(202).json(resposta); }
        const token = tokenAleatorio();
        await pool.execute('UPDATE recuperacoes_senha SET usado_em = NOW() WHERE usuario_id = ? AND usado_em IS NULL', [usuario.id]);
        await pool.execute(
            'INSERT INTO recuperacoes_senha (usuario_id, token_hash, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))',
            [usuario.id, hashToken(token)]
        );
        const link = `${APP_URL}/painel#reset=${encodeURIComponent(token)}`;
        try {
            await enviarRecuperacao(usuario, link);
        } catch (emailErr) {
            console.error('[EMAIL RECUPERAÇÃO]', emailErr.message);
            await pool.execute('UPDATE recuperacoes_senha SET usado_em = NOW() WHERE token_hash = ?', [hashToken(token)]);
            return res.status(503).json({ erro: 'Não foi possível enviar o e-mail agora. Tente novamente mais tarde.' });
        }
        await aguardarTempoMinimo(inicio);
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

app.post('/api/usuarios', autenticar, protegerCsrf, exigirAdmin, async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 120);
    const email = normalizarEmail(req.body?.email);
    const papel = PAPEIS_VALIDOS.includes(req.body?.papel) ? req.body.papel : 'dentista';
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Informe o nome.' });
    if (!emailValido(email)) return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    if (!smtpConfigurado) return res.status(503).json({ erro: 'Configure o envio de e-mails antes de convidar alguém.' });
    let usuarioId = null;
    try {
        const senhaHash = await hashSenha(tokenAleatorio());
        const [r] = await pool.execute(
            'INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?, ?, ?, ?)',
            [nome, email, senhaHash, papel]
        );
        usuarioId = r.insertId;
        const token = tokenAleatorio();
        await pool.execute(
            'INSERT INTO recuperacoes_senha (usuario_id, token_hash, expira_em) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))',
            [usuarioId, hashToken(token)]
        );
        await enviarRecuperacao({ id: usuarioId, nome, email }, `${APP_URL}/painel#reset=${encodeURIComponent(token)}`, true);
        await registrarAuditoria(req, 'usuario_convidado', 'usuario', usuarioId, { papel });
        res.status(201).json({ id: usuarioId, nome, email, papel, ativo: 1, mensagem: 'Convite enviado por e-mail.' });
    } catch (err) {
        if (usuarioId && !['ER_DUP_ENTRY'].includes(err.code)) {
            await pool.execute('DELETE FROM usuarios WHERE id = ?', [usuarioId]).catch(() => {});
        }
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este e-mail já está cadastrado.' });
        if (usuarioId) return res.status(503).json({ erro: 'Não foi possível enviar o convite. A conta não foi criada.' });
        next(err);
    }
});

app.patch('/api/usuarios/:id/status', autenticar, protegerCsrf, exigirAdmin, async (req, res, next) => {
    const id = Number(req.params.id);
    if (typeof req.body?.ativo !== 'boolean') return res.status(400).json({ erro: 'Situação inválida.' });
    const ativo = req.body.ativo ? 1 : 0;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Usuário inválido.' });
    if (id === req.usuario.id && !ativo) return res.status(400).json({ erro: 'Você não pode desativar sua própria conta.' });
    try {
        const [r] = await pool.execute('UPDATE usuarios SET ativo = ? WHERE id = ?', [ativo, id]);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        if (!ativo) await pool.execute('DELETE FROM sessoes WHERE usuario_id = ?', [id]);
        await registrarAuditoria(req, ativo ? 'usuario_ativado' : 'usuario_desativado', 'usuario', id);
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

app.post('/api/clientes', autenticar, protegerCsrf, async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 120);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    const dataNascimento = sanitizar(req.body?.data_nascimento, 10);
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Informe o nome do paciente.' });
    if (!/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Informe telefone com DDD.' });
    if (email && !emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (dataNascimento && !dataValida(dataNascimento)) return res.status(400).json({ erro: 'Data de nascimento inválida.' });
    try {
        const [r] = await pool.execute('INSERT INTO clientes (nome, telefone, email, data_nascimento) VALUES (?, ?, ?, ?)', [nome, telefone, email, dataNascimento || null]);
        await registrarAuditoria(req, 'cliente_criado', 'cliente', r.insertId);
        res.status(201).json({ id: r.insertId, nome, telefone, email, data_nascimento: dataNascimento || null });
    } catch (err) {
        next(err);
    }
});

app.put('/api/clientes/:id', autenticar, protegerCsrf, async (req, res, next) => {
    const id = Number(req.params.id);
    const nome = sanitizar(req.body?.nome, 120);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    const dataNascimento = sanitizar(req.body?.data_nascimento, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Paciente inválido.' });
    if (!nome || !/^\d{10,11}$/.test(telefone) || (email && !emailValido(email)) || (dataNascimento && !dataValida(dataNascimento))) return res.status(400).json({ erro: 'Revise nome, telefone, e-mail e nascimento.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [r] = await conn.execute('UPDATE clientes SET nome = ?, telefone = ?, email = ?, data_nascimento = ? WHERE id = ?', [nome, telefone, email, dataNascimento || null, id]);
        if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ erro: 'Paciente não encontrado.' }); }
        await registrarAuditoria(req, 'cliente_atualizado', 'cliente', id, null, conn);
        await conn.commit();
        res.json({ id, nome, telefone, email, data_nascimento: dataNascimento || null });
    } catch (err) {
        await conn.rollback();
        next(err);
    } finally { conn.release(); }
});

app.get('/api/horarios-disponiveis', async (req, res, next) => {
    const { data } = req.query;
    if (!dataValida(data)) return res.status(400).json({ erro: 'Data inválida. Use AAAA-MM-DD.' });
    if (dataEhHojeOuPassada(data) || dataEhFimDeSemana(data)) return res.json({ data, disponiveis: [], todos: HORARIOS_VALIDOS });
    try {
        const [[reservas], [bloqueios]] = await Promise.all([
            pool.execute('SELECT horario FROM reservas_horario WHERE data = ?', [data]),
            pool.execute('SELECT horario FROM bloqueios_agenda WHERE data = ?', [data]),
        ]);
        const indisponiveis = new Set([...reservas, ...bloqueios].map(r => r.horario));
        const disponiveis = indisponiveis.has('*') ? [] : HORARIOS_VALIDOS.filter(h => !indisponiveis.has(h));
        res.json({ data, disponiveis, todos: HORARIOS_VALIDOS });
    } catch (err) { next(err); }
});

app.post('/api/agendamentos', rateLimit({ max: 8, janela: 10 * 60 * 1000, grupo: 'agendamento' }), async (req, res, next) => {
    if (sanitizar(req.body?.website, 120)) return res.status(201).json({ mensagem: 'Solicitação registrada.' });
    const nome = sanitizar(req.body?.nome, 100);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    const { data, horario, preferencia } = req.body || {};
    const observacoes = sanitizar(req.body?.observacoes, 500);
    if (!nome || nome.length < 2) return res.status(400).json({ erro: 'Nome inválido.' });
    if (!/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Telefone inválido. Informe DDD + número.' });
    if (email && !emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!dataValida(data) || dataEhHojeOuPassada(data)) return res.status(400).json({ erro: 'Escolha uma data futura válida.' });
    if (dataEhFimDeSemana(data)) return res.status(400).json({ erro: 'Atendemos de segunda a sexta.' });
    if (!HORARIOS_VALIDOS.includes(horario)) return res.status(400).json({ erro: 'Horário inválido.' });
    if (preferencia && !MOTIVOS_VALIDOS.includes(preferencia)) return res.status(400).json({ erro: 'Motivo de consulta inválido.' });
    if (req.body?.privacidadeAceita !== true) return res.status(400).json({ erro: 'Confirme que leu o aviso de privacidade.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[bloqueio]] = await conn.execute(
            `SELECT id FROM bloqueios_agenda WHERE data = ? AND horario IN ('*', ?) LIMIT 1 FOR UPDATE`,
            [data, horario]
        );
        if (bloqueio) { await conn.rollback(); return res.status(409).json({ erro: 'Este horário foi bloqueado pela clínica. Escolha outro.' }); }
        let [[cliente]] = await conn.execute(
            'SELECT id, email FROM clientes WHERE telefone = ? AND LOWER(TRIM(nome)) = LOWER(?) ORDER BY id LIMIT 1 FOR UPDATE',
            [telefone, nome]
        );
        if (!cliente) {
            const [novoCliente] = await conn.execute('INSERT INTO clientes (nome, telefone, email) VALUES (?, ?, ?)', [nome, telefone, email]);
            cliente = { id: novoCliente.insertId, email };
        } else if (email && !cliente.email) {
            await conn.execute('UPDATE clientes SET email = ? WHERE id = ?', [email, cliente.id]);
        }
        const [r] = await conn.execute(
            `INSERT INTO agendamentos
             (cliente_id, nome, telefone, email, data, horario, preferencia, observacoes, origem, privacidade_versao, privacidade_aceita_em, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'site', '2026-08-10', NOW(), 'pendente')`,
            [cliente.id, nome, telefone, email, data, horario, preferencia || null, observacoes]
        );
        await conn.execute('INSERT INTO reservas_horario (data, horario, agendamento_id) VALUES (?, ?, ?)', [data, horario, r.insertId]);
        await conn.commit();
        const protocolo = `AG-${new Date().getFullYear()}-${String(r.insertId).padStart(5, '0')}`;
        const agendamento = { id: r.insertId, protocolo, nome, telefone, email, data, horario, preferencia };
        const envios = await Promise.allSettled([
            enviarEmailAgendamento(agendamento, 'recebido'),
            notificarClinicaNovoAgendamento(agendamento),
        ]);
        envios.filter(x => x.status === 'rejected').forEach(x => console.error('[EMAIL AGENDAMENTO]', x.reason?.message || x.reason));
        res.status(201).json({ id: r.insertId, protocolo, mensagem: 'Solicitação registrada.', emailEnviado: !!email && envios[0]?.status === 'fulfilled' && envios[0].value === true });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este horário acabou de ser reservado. Escolha outro.' });
        next(err);
    } finally { conn.release(); }
});

app.get('/api/agendamentos', autenticar, async (req, res, next) => {
    try {
        const camposRestritos = req.usuario.papel === 'recepcao'
            ? 'NULL AS observacoes, NULL AS valor, 0 AS pago, NULL AS forma_pagamento, NULL AS pago_em'
            : 'a.observacoes, a.valor, a.pago, a.forma_pagamento, a.pago_em';
        const [linhas] = await pool.query(
            `SELECT a.id, a.cliente_id, a.nome, a.telefone, a.email, a.data, a.horario,
                    a.preferencia, a.origem, a.profissional_id, a.status, a.motivo_cancelamento,
                    a.criadoEm, a.atualizado_em, ${camposRestritos}, u.nome AS profissional_nome
             FROM agendamentos a LEFT JOIN usuarios u ON u.id = a.profissional_id
             ORDER BY a.data DESC, a.horario ASC LIMIT 5000`
        );
        res.json(linhas);
    } catch (err) { next(err); }
});

app.post('/api/agendamentos/interno', autenticar, protegerCsrf, async (req, res, next) => {
    const nome = sanitizar(req.body?.nome, 100);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    const data = sanitizar(req.body?.data, 10);
    const horario = sanitizar(req.body?.horario, 5);
    const preferencia = sanitizar(req.body?.preferencia, 50);
    const observacoes = sanitizar(req.body?.observacoes, 1000);
    const status = STATUS_ATIVOS.includes(req.body?.status) ? req.body.status : 'confirmada';
    const profissionalId = req.body?.profissional_id ? Number(req.body.profissional_id) : null;
    if (!nome || nome.length < 2 || !/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Revise nome e telefone.' });
    if (email && !emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!dataValida(data) || dataEhPassada(data) || dataEhFimDeSemana(data)) return res.status(400).json({ erro: 'Escolha uma data útil válida.' });
    if (!HORARIOS_VALIDOS.includes(horario)) return res.status(400).json({ erro: 'Horário inválido.' });
    if (preferencia && !MOTIVOS_VALIDOS.includes(preferencia)) return res.status(400).json({ erro: 'Motivo inválido.' });
    if (profissionalId && (!Number.isInteger(profissionalId) || profissionalId < 1)) return res.status(400).json({ erro: 'Profissional inválido.' });

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[bloqueio]] = await conn.execute(`SELECT id FROM bloqueios_agenda WHERE data = ? AND horario IN ('*', ?) LIMIT 1 FOR UPDATE`, [data, horario]);
        if (bloqueio) { await conn.rollback(); return res.status(409).json({ erro: 'Este horário está bloqueado.' }); }
        let [[cliente]] = await conn.execute(
            'SELECT id FROM clientes WHERE telefone = ? AND LOWER(TRIM(nome)) = LOWER(?) ORDER BY id LIMIT 1 FOR UPDATE',
            [telefone, nome]
        );
        if (!cliente) {
            const [novoCliente] = await conn.execute('INSERT INTO clientes (nome, telefone, email) VALUES (?, ?, ?)', [nome, telefone, email]);
            cliente = { id: novoCliente.insertId };
        }
        const [r] = await conn.execute(
            `INSERT INTO agendamentos
             (cliente_id, nome, telefone, email, data, horario, preferencia, observacoes, origem, profissional_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'painel', ?, ?)`,
            [cliente.id, nome, telefone, email, data, horario, preferencia || null, observacoes, profissionalId, status]
        );
        await conn.execute('INSERT INTO reservas_horario (data, horario, agendamento_id) VALUES (?, ?, ?)', [data, horario, r.insertId]);
        await registrarAuditoria(req, 'agendamento_criado', 'agendamento', r.insertId, { origem: 'painel', status }, conn);
        await conn.commit();
        const protocolo = `AG-${new Date().getFullYear()}-${String(r.insertId).padStart(5, '0')}`;
        if (email) enviarEmailAgendamento({ id: r.insertId, protocolo, nome, email, data, horario }, status).catch(err => console.error('[EMAIL AGENDAMENTO]', err.message));
        res.status(201).json({ id: r.insertId, protocolo, mensagem: 'Agendamento criado.' });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este horário já está reservado.' });
        next(err);
    } finally { conn.release(); }
});

app.put('/api/agendamentos/:id', autenticar, protegerCsrf, async (req, res, next) => {
    const id = Number(req.params.id);
    const nome = sanitizar(req.body?.nome, 100);
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const email = normalizarEmail(req.body?.email) || null;
    const data = sanitizar(req.body?.data, 10);
    const horario = sanitizar(req.body?.horario, 5);
    const preferencia = sanitizar(req.body?.preferencia, 50);
    const observacoes = sanitizar(req.body?.observacoes, 1000);
    const profissionalId = req.body?.profissional_id ? Number(req.body.profissional_id) : null;
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Agendamento inválido.' });
    if (!nome || nome.length < 2 || !/^\d{10,11}$/.test(telefone)) return res.status(400).json({ erro: 'Revise nome e telefone.' });
    if (email && !emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!dataValida(data) || dataEhPassada(data) || dataEhFimDeSemana(data) || !HORARIOS_VALIDOS.includes(horario)) return res.status(400).json({ erro: 'Revise data e horário.' });
    if (preferencia && !MOTIVOS_VALIDOS.includes(preferencia)) return res.status(400).json({ erro: 'Motivo inválido.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[atual]] = await conn.execute('SELECT * FROM agendamentos WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
        if (!atual) { await conn.rollback(); return res.status(404).json({ erro: 'Agendamento não encontrado.' }); }
        if (STATUS_ATIVOS.includes(atual.status || 'pendente')) {
            await conn.execute('DELETE FROM reservas_horario WHERE agendamento_id = ?', [id]);
            const [[bloqueio]] = await conn.execute(`SELECT id FROM bloqueios_agenda WHERE data = ? AND horario IN ('*', ?) LIMIT 1 FOR UPDATE`, [data, horario]);
            if (bloqueio) { await conn.rollback(); return res.status(409).json({ erro: 'O novo horário está bloqueado.' }); }
            await conn.execute('INSERT INTO reservas_horario (data, horario, agendamento_id) VALUES (?, ?, ?)', [data, horario, id]);
        }
        await conn.execute(
            `UPDATE agendamentos SET nome = ?, telefone = ?, email = ?, data = ?, horario = ?,
             preferencia = ?, observacoes = ?, profissional_id = ? WHERE id = ?`,
            [nome, telefone, email, data, horario, preferencia || null, observacoes, profissionalId, id]
        );
        await registrarAuditoria(req, 'agendamento_atualizado', 'agendamento', id, { dataAnterior: dataIso(atual.data), horarioAnterior: atual.horario }, conn);
        await conn.commit();
        res.json({ mensagem: 'Agendamento atualizado.' });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'O novo horário já está reservado.' });
        next(err);
    } finally { conn.release(); }
});

app.delete('/api/agendamentos/:id', autenticar, protegerCsrf, exigirAdmin, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [r] = await conn.execute(
            `UPDATE agendamentos SET status = 'cancelada', motivo_cancelamento = 'Cancelado administrativamente'
             WHERE id = ?`,
            [id]
        );
        if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ erro: 'Agendamento não encontrado.' }); }
        await conn.execute('DELETE FROM reservas_horario WHERE agendamento_id = ?', [id]);
        await registrarAuditoria(req, 'agendamento_cancelado', 'agendamento', id, { via: 'exclusao' }, conn);
        await conn.commit();
        res.status(204).send();
    } catch (err) { await conn.rollback(); next(err); }
    finally { conn.release(); }
});

app.put('/api/agendamentos/:id/status', autenticar, protegerCsrf, async (req, res, next) => {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    const motivo = sanitizar(req.body?.motivo, 300);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
    if (status === 'cancelada' && (!motivo || motivo.length < 3)) return res.status(400).json({ erro: 'Informe o motivo do cancelamento.' });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[agendamento]] = await conn.execute('SELECT * FROM agendamentos WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
        if (!agendamento) { await conn.rollback(); return res.status(404).json({ erro: 'Agendamento não encontrado.' }); }
        const eraAtivo = STATUS_ATIVOS.includes(agendamento.status || 'pendente');
        const seraAtivo = STATUS_ATIVOS.includes(status);
        if (eraAtivo && !seraAtivo) await conn.execute('DELETE FROM reservas_horario WHERE agendamento_id = ?', [id]);
        if (!eraAtivo && seraAtivo) {
            const [[bloqueio]] = await conn.execute(`SELECT id FROM bloqueios_agenda WHERE data = ? AND horario IN ('*', ?) LIMIT 1 FOR UPDATE`, [dataIso(agendamento.data), agendamento.horario]);
            if (bloqueio) { await conn.rollback(); return res.status(409).json({ erro: 'Este horário está bloqueado.' }); }
            await conn.execute('INSERT INTO reservas_horario (data, horario, agendamento_id) VALUES (?, ?, ?)', [dataIso(agendamento.data), agendamento.horario, id]);
        }
        await conn.execute(
            'UPDATE agendamentos SET status = ?, motivo_cancelamento = ? WHERE id = ?',
            [status, status === 'cancelada' ? motivo : null, id]
        );
        await registrarAuditoria(req, 'status_agendamento_alterado', 'agendamento', id, { anterior: agendamento.status, atual: status }, conn);
        await conn.commit();
        if (agendamento.email && ['confirmada','cancelada','concluida'].includes(status)) {
            enviarEmailAgendamento({ ...agendamento, protocolo: `AG-${new Date().getFullYear()}-${String(id).padStart(5, '0')}` }, status)
                .catch(err => console.error('[EMAIL STATUS]', err.message));
        }
        res.json({ mensagem: 'Status atualizado.' });
    } catch (err) {
        await conn.rollback();
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este horário já está reservado.' });
        next(err);
    } finally { conn.release(); }
});

app.put('/api/agendamentos/:id/financeiro', autenticar, protegerCsrf, exigirPapeis('admin','dentista'), async (req, res, next) => {
    const id = Number(req.params.id);
    const { valor, pago } = req.body || {};
    const formaPagamento = sanitizar(req.body?.forma_pagamento, 30);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID inválido.' });
    if (valor === undefined && pago === undefined) return res.status(400).json({ erro: 'Informe valor ou situação.' });
    if (valor !== undefined && (!Number.isFinite(Number(valor)) || Number(valor) < 0)) return res.status(400).json({ erro: 'Valor inválido.' });
    if (pago !== undefined && typeof pago !== 'boolean') return res.status(400).json({ erro: 'Situação de pagamento inválida.' });
    try {
        const campos = [], params = [];
        if (valor !== undefined) { campos.push('valor = ?'); params.push(Number(valor)); }
        if (pago !== undefined) {
            campos.push('pago = ?', 'pago_em = ?');
            params.push(pago ? 1 : 0, pago ? new Date() : null);
        }
        if (formaPagamento !== null) { campos.push('forma_pagamento = ?'); params.push(formaPagamento || null); }
        params.push(id);
        const [r] = await pool.execute(`UPDATE agendamentos SET ${campos.join(', ')} WHERE id = ?`, params);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Agendamento não encontrado.' });
        await registrarAuditoria(req, 'financeiro_atualizado', 'agendamento', id, { pago: pago === true });
        res.json({ mensagem: 'Dados financeiros atualizados.' });
    } catch (err) { next(err); }
});

app.get('/api/financeiro/resumo', autenticar, exigirPapeis('admin','dentista'), async (req, res, next) => {
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
                    SUM(CASE WHEN status = 'concluida' THEN 1 ELSE 0 END) AS totalCompareceram,
                    SUM(CASE WHEN status = 'faltou' THEN 1 ELSE 0 END) AS totalFaltaram,
                    COALESCE(SUM(CASE WHEN status NOT IN ('faltou','cancelada') THEN valor ELSE 0 END), 0) AS receitaTotal,
                    COALESCE(SUM(CASE WHEN pago = 1 AND status NOT IN ('faltou','cancelada') THEN valor ELSE 0 END), 0) AS receitaRecebida,
                    COALESCE(SUM(CASE WHEN pago = 0 AND valor IS NOT NULL AND status NOT IN ('faltou','cancelada') THEN valor ELSE 0 END), 0) AS receitaPendente
             FROM agendamentos WHERE data BETWEEN ? AND ?`,
            [inicio, fim]
        );
        res.json({ periodo: { inicio, fim }, ...totais });
    } catch (err) { next(err); }
});

app.get('/api/agenda/bloqueios', autenticar, async (req, res, next) => {
    try {
        const [linhas] = await pool.query(
            `SELECT b.id, b.data, b.horario, b.motivo, b.criado_em, u.nome AS criado_por_nome
             FROM bloqueios_agenda b LEFT JOIN usuarios u ON u.id = b.criado_por
             WHERE b.data >= CURDATE() ORDER BY b.data, b.horario LIMIT 500`
        );
        res.json(linhas);
    } catch (err) { next(err); }
});

app.post('/api/agenda/bloqueios', autenticar, protegerCsrf, async (req, res, next) => {
    const data = sanitizar(req.body?.data, 10);
    const horario = req.body?.horario ? sanitizar(req.body.horario, 5) : '*';
    const motivo = sanitizar(req.body?.motivo, 180);
    if (!dataValida(data) || dataEhPassada(data)) return res.status(400).json({ erro: 'Data inválida.' });
    if (horario !== '*' && !HORARIOS_VALIDOS.includes(horario)) return res.status(400).json({ erro: 'Horário inválido.' });
    try {
        const params = horario === '*' ? [data] : [data, horario];
        const sql = horario === '*'
            ? 'SELECT COUNT(*) AS total FROM reservas_horario WHERE data = ?'
            : 'SELECT COUNT(*) AS total FROM reservas_horario WHERE data = ? AND horario = ?';
        const [[ocupado]] = await pool.execute(sql, params);
        if (Number(ocupado.total) > 0) return res.status(409).json({ erro: 'Há consulta reservada nesse período. Remarque ou cancele antes de bloquear.' });
        const [r] = await pool.execute(
            'INSERT INTO bloqueios_agenda (data, horario, motivo, criado_por) VALUES (?, ?, ?, ?)',
            [data, horario, motivo, req.usuario.id]
        );
        await registrarAuditoria(req, 'agenda_bloqueada', 'bloqueio', r.insertId, { data, horario });
        res.status(201).json({ id: r.insertId, data, horario, motivo });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Este período já está bloqueado.' });
        next(err);
    }
});

app.delete('/api/agenda/bloqueios/:id', autenticar, protegerCsrf, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Bloqueio inválido.' });
    try {
        const [r] = await pool.execute('DELETE FROM bloqueios_agenda WHERE id = ?', [id]);
        if (!r.affectedRows) return res.status(404).json({ erro: 'Bloqueio não encontrado.' });
        await registrarAuditoria(req, 'agenda_desbloqueada', 'bloqueio', id);
        res.status(204).send();
    } catch (err) { next(err); }
});

app.get('/api/exportar/agendamentos.csv', autenticar, exigirPapeis('admin','dentista'), async (req, res, next) => {
    try {
        const [linhas] = await pool.query(
            `SELECT id, nome, telefone, email, data, horario, preferencia, status, valor, pago, forma_pagamento, origem
             FROM agendamentos ORDER BY data DESC, horario`
        );
        const cabecalho = ['ID','Paciente','Telefone','E-mail','Data','Horário','Motivo','Status','Valor','Pago','Forma de pagamento','Origem'];
        const csv = [cabecalho, ...linhas.map(l => [l.id,l.nome,l.telefone,l.email,dataIso(l.data),l.horario,l.preferencia,l.status,l.valor,l.pago ? 'sim' : 'não',l.forma_pagamento,l.origem])]
            .map(linha => linha.map(campoCsv).join(';')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="agendamentos-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(`\uFEFF${csv}`);
    } catch (err) { next(err); }
});

app.get('/api/exportar/clientes.csv', autenticar, exigirPapeis('admin','dentista'), async (req, res, next) => {
    try {
        const [linhas] = await pool.query('SELECT id, nome, telefone, email, data_nascimento, criado_em FROM clientes ORDER BY nome');
        const cabecalho = ['ID','Paciente','Telefone','E-mail','Nascimento','Cadastrado em'];
        const csv = [cabecalho, ...linhas.map(l => [l.id,l.nome,l.telefone,l.email,dataIso(l.data_nascimento),l.criado_em?.toISOString?.() || l.criado_em])]
            .map(linha => linha.map(campoCsv).join(';')).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pacientes-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(`\uFEFF${csv}`);
    } catch (err) { next(err); }
});

app.get('/api/sistema/status', autenticar, exigirAdmin, async (_req, res) => {
    res.json({
        ambiente: NODE_ENV,
        emailConfigurado: smtpConfigurado,
        urlSegura: APP_URL.startsWith('https://'),
        horarios: HORARIOS_VALIDOS,
    });
});

app.post('/api/sistema/testar-email', autenticar, protegerCsrf, exigirAdmin, async (req, res, next) => {
    if (!smtpConfigurado) return res.status(503).json({ erro: 'O envio de e-mails ainda não está configurado.' });
    try {
        await enviarEmail({
            para: req.usuario.email,
            assunto: `Teste de e-mail — ${CLINIC_NAME}`,
            texto: `Olá, ${req.usuario.nome}. O envio de e-mails do ${CLINIC_NAME} está funcionando.`,
            html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="color:#0f766e">E-mail funcionando</h2><p>Olá, ${escaparHtml(req.usuario.nome)}.</p><p>O envio de mensagens do <strong>${escaparHtml(CLINIC_NAME)}</strong> foi configurado corretamente.</p></div>`,
        });
        await registrarAuditoria(req, 'email_teste_enviado', 'sistema', null);
        res.json({ mensagem: `E-mail de teste enviado para ${req.usuario.email}.` });
    } catch (err) {
        console.error('[EMAIL TESTE]', err.message);
        res.status(503).json({ erro: 'Não foi possível enviar. Confira o e-mail e a senha de app e tente novamente.' });
    }
});

app.get('/api/auditoria', autenticar, exigirAdmin, async (req, res, next) => {
    try {
        const [linhas] = await pool.query(
            `SELECT a.id, a.acao, a.entidade, a.entidade_id, a.criado_em, u.nome AS usuario_nome
             FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
             ORDER BY a.id DESC LIMIT 200`
        );
        res.json(linhas);
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

function validarConfiguracaoProducao(totalUsuarios) {
    if (NODE_ENV !== 'production') return;
    const faltas = [];
    if (!APP_URL.startsWith('https://')) faltas.push('APP_URL precisa usar HTTPS');
    if (ALLOWED_ORIGIN === '*' || !origensPermitidas.includes(APP_URL)) faltas.push('ALLOWED_ORIGIN precisa conter a APP_URL');
    if (!smtpConfigurado || !process.env.MAIL_FROM) faltas.push('SMTP e MAIL_FROM precisam estar configurados');
    if (!process.env.DB_PASSWORD) faltas.push('DB_PASSWORD não pode ficar vazio');
    if (Number(totalUsuarios) === 0 && String(SETUP_CODE).length < 24) faltas.push('SETUP_TOKEN precisa ter pelo menos 24 caracteres');
    if (!HORARIOS_VALIDOS.length) faltas.push('SCHEDULE_SLOTS não contém horários válidos');
    if (faltas.length) throw new Error(`Configuração de produção incompleta: ${faltas.join('; ')}`);
}

let servidor;

async function iniciar() {
    const conn = await pool.getConnection();
    try {
        const [[estrutura]] = await conn.query(
            `SELECT COUNT(*) AS total FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN ('agendamentos','usuarios','clientes','sessoes','recuperacoes_senha','reservas_horario','bloqueios_agenda','auditoria')`
        );
        if (Number(estrutura.total) < 8) throw new Error('Estrutura do banco ausente ou desatualizada. Execute: npm run migrate');
        const [[versao]] = await conn.query("SELECT COUNT(*) AS total FROM schema_migrations WHERE id = '002_agenda_producao'");
        if (Number(versao.total) !== 1) throw new Error('Migração 002_agenda_producao pendente. Execute: npm run migrate');
        const [[usuarios]] = await conn.query('SELECT COUNT(*) AS total FROM usuarios');
        validarConfiguracaoProducao(usuarios.total);
    } finally { conn.release(); }
    if (NODE_ENV === 'production') await transportador.verify();
    const limpezaSessoes = setInterval(() => {
        pool.query('DELETE FROM sessoes WHERE expira_em <= NOW()').catch(() => {});
        pool.query('DELETE FROM recuperacoes_senha WHERE expira_em < DATE_SUB(NOW(), INTERVAL 1 DAY)').catch(() => {});
    }, 60 * 60 * 1000);
    limpezaSessoes.unref();
    servidor = app.listen(PORT, () => {
        console.log(`Servidor Site Cliente ativo em ${APP_URL}`);
        console.log(`Banco conectado; e-mail de recuperação: ${smtpConfigurado ? 'configurado' : 'não configurado'}.`);
    });
    servidor.requestTimeout = 30_000;
    servidor.headersTimeout = 35_000;
}

iniciar().catch(err => {
    console.error('Falha ao iniciar:', err.message);
    process.exit(1);
});

async function encerrar(sinal) {
    console.log(`Recebido ${sinal}; encerrando com segurança.`);
    if (servidor) await new Promise(resolve => servidor.close(resolve));
    await pool.end().catch(() => {});
    process.exit(0);
}

process.once('SIGTERM', () => encerrar('SIGTERM'));
process.once('SIGINT', () => encerrar('SIGINT'));
