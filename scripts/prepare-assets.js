'use strict';

const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const publico = path.join(raiz, 'public', 'assets');

function copiar(origem, destino) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.cpSync(origem, destino, { recursive: true, force: true });
}

copiar(path.join(raiz, 'node_modules', 'react', 'umd', 'react.production.min.js'), path.join(publico, 'react.production.min.js'));
copiar(path.join(raiz, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js'), path.join(publico, 'react-dom.production.min.js'));
copiar(path.join(raiz, 'node_modules', '@babel', 'standalone', 'babel.min.js'), path.join(publico, 'babel.min.js'));
copiar(path.join(raiz, 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'all.min.css'), path.join(publico, 'fontawesome', 'css', 'all.min.css'));
copiar(path.join(raiz, 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts'), path.join(publico, 'fontawesome', 'webfonts'));

console.log('Assets locais preparados.');
