'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Babel = require('@babel/standalone');

for (const arquivo of ['SitePaciente.html', 'PainelDentista.html']) {
    test(`JSX válido em ${arquivo}`, () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', arquivo), 'utf8');
        const trecho = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
        assert.ok(trecho, `script Babel não encontrado em ${arquivo}`);
        assert.doesNotThrow(() => Babel.transform(trecho[1], { presets:['react'], filename:arquivo }));
        assert.match(html, /ReactDOM\.createRoot/);
    });
}
