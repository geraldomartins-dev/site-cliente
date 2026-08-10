'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function normalizarEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function emailValido(email) {
    const valor = normalizarEmail(email);
    return valor.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor);
}

function validarSenha(senha) {
    const valor = String(senha || '');
    if (valor.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (valor.length > 128) return 'A senha pode ter no máximo 128 caracteres.';
    if (!/[A-Za-zÀ-ÿ]/.test(valor) || !/\d/.test(valor)) {
        return 'Use pelo menos uma letra e um número.';
    }
    return null;
}

async function hashSenha(senha) {
    const salt = crypto.randomBytes(16);
    const derivada = await scryptAsync(String(senha), salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
    return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('hex')}$${derivada.toString('hex')}`;
}

async function verificarSenha(senha, armazenada) {
    try {
        const [algoritmo, n, r, p, saltHex, hashHex] = String(armazenada || '').split('$');
        if (algoritmo !== 'scrypt' || !saltHex || !hashHex) return false;
        const esperado = Buffer.from(hashHex, 'hex');
        const derivada = await scryptAsync(String(senha), Buffer.from(saltHex, 'hex'), esperado.length, {
            N: Number(n), r: Number(r), p: Number(p), maxmem: 32 * 1024 * 1024,
        });
        return esperado.length === derivada.length && crypto.timingSafeEqual(esperado, derivada);
    } catch {
        return false;
    }
}

function tokenAleatorio(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function compararSegredo(a, b) {
    const esquerda = Buffer.from(String(a || ''));
    const direita = Buffer.from(String(b || ''));
    return esquerda.length === direita.length && esquerda.length > 0 && crypto.timingSafeEqual(esquerda, direita);
}

module.exports = {
    normalizarEmail,
    emailValido,
    validarSenha,
    hashSenha,
    verificarSenha,
    tokenAleatorio,
    hashToken,
    compararSegredo,
};
