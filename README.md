# Site Cliente

Site público de atendimento e painel privado para a clínica odontológica da Dra. Naty.

## Recursos

- Solicitação de consultas com consulta de horários disponíveis.
- Cadastro automático e centralizado de pacientes.
- Agenda, histórico de atendimentos e controle financeiro.
- Login individual por e-mail e senha.
- Primeira conta protegida por código de configuração.
- Sessões revogáveis armazenadas no MySQL, com cookie `HttpOnly`.
- Recuperação de senha por link único com validade de 30 minutos.
- Gestão de usuários da equipe e ativação/desativação de acessos.
- Layout responsivo para computador e celular.

## Requisitos

- Node.js 18 ou superior.
- MySQL ou MariaDB.

## Configuração local

1. Copie `.env.example` para `.env` e preencha as configurações do banco.
2. Defina um `SETUP_TOKEN` longo, usado apenas no primeiro cadastro.
3. Instale as dependências:

   ```powershell
   npm.cmd install
   ```

4. Crie e atualize as tabelas sem apagar os agendamentos existentes:

   ```powershell
   npm.cmd run migrate
   ```

5. Inicie o servidor:

   ```powershell
   npm.cmd start
   ```

6. Abra `http://localhost:3001/painel` e escolha **Criar primeira conta**.

O site público fica em `http://localhost:3001`.

## Recuperação de senha

Em produção, configure as variáveis `SMTP_*` e `MAIL_FROM`. Para Gmail, utilize uma senha de app, nunca a senha normal da conta. Sem SMTP, no ambiente de desenvolvimento o painel exibe o link local de redefinição para permitir testes.

## Segurança e privacidade

- O arquivo `.env`, backups, `node_modules` e dados reais não são versionados.
- Senhas usam `scrypt` com salt individual; o banco nunca armazena a senha original.
- Tokens de sessão e recuperação são armazenados somente como hash.
- Este projeto não substitui um prontuário odontológico certificado. Guarde apenas os dados necessários e aplique as obrigações da LGPD antes de uso em produção.

## Testes

```powershell
npm.cmd test
```
