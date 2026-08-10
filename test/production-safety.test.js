'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const ler = arquivo => fs.readFileSync(path.join(raiz, arquivo), 'utf8');

test('recuperação nunca devolve token ou link de desenvolvimento', () => {
    const servidor = ler('server.js');
    assert.doesNotMatch(servidor, /linkDesenvolvimento/);
    assert.doesNotMatch(servidor, /SETUP_TOKEN\s*\|\|\s*process\.env\.ADMIN_PASSWORD/);
    assert.match(servidor, /Não foi possível enviar o e-mail agora/);
});

test('interface usa assets locais para recursos essenciais', () => {
    for (const arquivo of ['public/SitePaciente.html', 'public/PainelDentista.html']) {
        const html = ler(arquivo);
        assert.doesNotMatch(html, /cdn\.tailwindcss\.com|unpkg\.com|cdnjs\.cloudflare\.com/);
        assert.match(html, /\/assets\/site\.css/);
        assert.match(html, /\/assets\/fontawesome\/css\/all\.min\.css/);
    }
});

test('migration contém garantia de reserva, bloqueios e auditoria', () => {
    const migration = ler('database/migrate.js');
    assert.match(migration, /CREATE TABLE IF NOT EXISTS reservas_horario/);
    assert.match(migration, /PRIMARY KEY \(data, horario\)/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS bloqueios_agenda/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS auditoria/);
});

test('configuração documenta e-mail e dados públicos', () => {
    const exemplo = ler('.env.example');
    for (const chave of ['SMTP_USER=', 'SMTP_PASS=', 'MAIL_FROM=', 'NOTIFICATION_EMAIL=', 'CLINIC_WHATSAPP=']) {
        assert.match(exemplo, new RegExp(chave));
    }
});
