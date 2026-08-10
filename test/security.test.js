'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizarEmail, emailValido, validarSenha, hashSenha,
    verificarSenha, tokenAleatorio, hashToken, compararSegredo,
} = require('../lib/security');

test('normaliza e valida e-mails', () => {
    assert.equal(normalizarEmail('  Naty@Exemplo.COM '), 'naty@exemplo.com');
    assert.equal(emailValido('naty@exemplo.com'), true);
    assert.equal(emailValido('email-invalido'), false);
});

test('exige senha com tamanho, letra e número', () => {
    assert.match(validarSenha('curta1'), /8 caracteres/);
    assert.match(validarSenha('abcdefgh'), /letra e um número/);
    assert.equal(validarSenha('Sorriso2026'), null);
});

test('hash de senha é salgado e verificável', async () => {
    const a = await hashSenha('Sorriso2026');
    const b = await hashSenha('Sorriso2026');
    assert.notEqual(a, b);
    assert.equal(await verificarSenha('Sorriso2026', a), true);
    assert.equal(await verificarSenha('senha-errada', a), false);
});

test('tokens são aleatórios, hasheados e comparáveis com segurança', () => {
    const token = tokenAleatorio();
    assert.equal(token.length, 64);
    assert.equal(hashToken(token).length, 64);
    assert.equal(compararSegredo('codigo-seguro', 'codigo-seguro'), true);
    assert.equal(compararSegredo('codigo-seguro', 'outro'), false);
});
