'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function colunaExiste(conn, tabela, coluna) {
    const [[r]] = await conn.execute(
        `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tabela, coluna]
    );
    return Number(r.total) > 0;
}

async function indiceExiste(conn, tabela, indice) {
    const [[r]] = await conn.execute(
        `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [tabela, indice]
    );
    return Number(r.total) > 0;
}

async function constraintExiste(conn, tabela, nome) {
    const [[r]] = await conn.execute(
        `SELECT COUNT(*) AS total FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
        [tabela, nome]
    );
    return Number(r.total) > 0;
}

async function criarBackup(conn) {
    const [agendamentos] = await conn.query('SELECT * FROM agendamentos ORDER BY id');
    if (!agendamentos.length) return;
    const pasta = path.join(__dirname, '..', '.backups');
    fs.mkdirSync(pasta, { recursive: true });
    const existentes = fs.readdirSync(pasta).some(nome => nome.startsWith('agendamentos-antes-autenticacao-'));
    if (existentes) return;
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const arquivo = path.join(pasta, `agendamentos-antes-autenticacao-${carimbo}.json`);
    fs.writeFileSync(arquivo, JSON.stringify(agendamentos, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.log(`✓ Backup local criado em .backups/${path.basename(arquivo)}`);
}

async function migrar() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'clinica_dentaria',
        timezone: '-03:00',
    });

    try {
        console.log('Aplicando estrutura segura do banco...');
        await criarBackup(conn);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id VARCHAR(100) NOT NULL PRIMARY KEY,
                aplicado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(120) NOT NULL,
                email VARCHAR(190) NOT NULL,
                senha_hash VARCHAR(255) NOT NULL,
                papel ENUM('admin','dentista','recepcao') NOT NULL DEFAULT 'dentista',
                ativo TINYINT(1) NOT NULL DEFAULT 1,
                ultimo_login_em DATETIME NULL,
                criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_usuarios_email (email),
                KEY idx_usuarios_ativo (ativo)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                nome VARCHAR(120) NOT NULL,
                telefone VARCHAR(20) NOT NULL,
                email VARCHAR(190) NULL,
                data_nascimento DATE NULL,
                criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                atualizado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_clientes_telefone (telefone),
                KEY idx_clientes_nome (nome),
                KEY idx_clientes_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS sessoes (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL,
                expira_em DATETIME NOT NULL,
                criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ultimo_uso_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                user_agent VARCHAR(255) NULL,
                UNIQUE KEY uk_sessoes_token (token_hash),
                KEY idx_sessoes_usuario (usuario_id),
                KEY idx_sessoes_expiracao (expira_em),
                CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS recuperacoes_senha (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL,
                expira_em DATETIME NOT NULL,
                usado_em DATETIME NULL,
                criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uk_recuperacoes_token (token_hash),
                KEY idx_recuperacoes_usuario (usuario_id),
                KEY idx_recuperacoes_expiracao (expira_em),
                CONSTRAINT fk_recuperacoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        if (!(await colunaExiste(conn, 'agendamentos', 'cliente_id'))) {
            await conn.query('ALTER TABLE agendamentos ADD COLUMN cliente_id INT UNSIGNED NULL AFTER id');
        }
        if (!(await indiceExiste(conn, 'agendamentos', 'idx_agendamentos_cliente'))) {
            await conn.query('ALTER TABLE agendamentos ADD INDEX idx_agendamentos_cliente (cliente_id)');
        }
        if (!(await constraintExiste(conn, 'agendamentos', 'fk_agendamentos_cliente'))) {
            await conn.query(`ALTER TABLE agendamentos
                ADD CONSTRAINT fk_agendamentos_cliente FOREIGN KEY (cliente_id)
                REFERENCES clientes(id) ON DELETE SET NULL`);
        }

        const [antigos] = await conn.query(
            `SELECT id, nome, telefone FROM agendamentos
             WHERE cliente_id IS NULL AND telefone IS NOT NULL AND telefone <> '' ORDER BY id`
        );
        for (const item of antigos) {
            const telefone = String(item.telefone).replace(/\D/g, '').slice(0, 20);
            if (!telefone) continue;
            await conn.execute(
                `INSERT INTO clientes (nome, telefone) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE nome = IF(CHAR_LENGTH(VALUES(nome)) > CHAR_LENGTH(nome), VALUES(nome), nome)`,
                [String(item.nome || 'Paciente').trim().slice(0, 120), telefone]
            );
            const [[cliente]] = await conn.execute('SELECT id FROM clientes WHERE telefone = ? LIMIT 1', [telefone]);
            if (cliente) await conn.execute('UPDATE agendamentos SET cliente_id = ? WHERE id = ?', [cliente.id, item.id]);
        }

        await conn.execute(
            `INSERT INTO schema_migrations (id) VALUES ('001_auth_clientes')
             ON DUPLICATE KEY UPDATE id = VALUES(id)`
        );
        console.log(`✓ Migração concluída; ${antigos.length} agendamento(s) vinculado(s) a clientes.`);
    } finally {
        await conn.end();
    }
}

migrar().catch(err => {
    console.error('Falha ao migrar o banco:', err.code || err.message);
    process.exit(1);
});
