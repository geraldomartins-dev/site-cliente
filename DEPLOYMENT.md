# Publicação em produção

Este sistema precisa de três serviços: aplicação Node.js, banco MySQL/MariaDB persistente e um remetente SMTP. O GitHub guarda o código, mas não executa o servidor nem hospeda o banco.

## Antes de publicar

1. Confirme nome profissional, CRO, telefone/WhatsApp, Instagram e endereço.
2. Use um banco exclusivo, com usuário próprio e senha forte; não use `root`.
3. Faça um backup criptografado do banco e teste a restauração.
4. Configure domínio e HTTPS no provedor.
5. Configure o remetente de e-mail e use **Enviar e-mail de teste** no painel.
6. Faça revisão jurídica do Aviso de Privacidade e dos fluxos que tratem dados de saúde.

## Variáveis obrigatórias

Use `.env.example` como lista. Em produção, no mínimo:

- `NODE_ENV=production`
- `PORT` fornecida pelo provedor
- `APP_URL=https://seu-dominio`
- `ALLOWED_ORIGIN=https://seu-dominio`
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
- `NOTIFICATION_EMAIL`
- `CLINIC_NAME`, `CLINIC_WHATSAPP`, `CLINIC_PHONE_DISPLAY`, `CLINIC_INSTAGRAM`, `CLINIC_ADDRESS`, `CLINIC_CRO`

Nunca envie `.env` ao GitHub.

## Processo de implantação

```text
npm ci
npm run build
npm run migrate
npm start
```

Execute a migration com uma credencial que possa alterar tabelas. A aplicação pode usar outra credencial limitada a leitura e gravação dos dados.

Depois valide:

- `/api/health` responde `status: ok`;
- site público abre e consulta horários;
- primeiro acesso/login funciona;
- teste de e-mail chega;
- criação, edição, cancelamento e bloqueio da agenda funcionam;
- perfil de recepção não enxerga financeiro;
- exportações abrem corretamente.

## Atualização e rollback

Antes de cada atualização, salve backup do banco e registre a versão implantada. Para voltar o código, implante a imagem/commit anterior. Nunca reverta uma migration destrutiva sem um plano e um backup testado.

## Operação

- Monitore `/api/health` a cada minuto.
- Retenha logs sem senhas, tokens, observações clínicas ou conteúdo de e-mails.
- Revise usuários ativos mensalmente.
- Teste backup e recuperação periodicamente.
- Aplique atualizações de segurança após validação em ambiente separado.
