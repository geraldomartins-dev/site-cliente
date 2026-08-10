# Site Cliente

Site público e painel privado de gestão para a clínica odontológica da Dra. Naty.

## O que está incluído

- Site responsivo com serviços, contatos, disponibilidade e pedido de consulta.
- E-mail opcional, protocolo e confirmação do pedido para o paciente.
- Agenda com criação, edição, confirmação, conclusão, falta, cancelamento e bloqueio de períodos.
- Cadastro e histórico administrativo por paciente sem misturar familiares que usam o mesmo telefone.
- Controle financeiro para administradores e dentistas, com exportação CSV.
- Login individual, sessão segura, recuperação de senha e convites enviados exclusivamente por e-mail.
- Perfis de administrador, dentista e recepção com permissões diferentes.
- Auditoria de alterações, proteção contra conflito de horário e CSRF.
- Aviso de Privacidade e registro da ciência no pedido público.
- Assets essenciais locais, sem depender de CDN para abrir a interface ou mostrar ícones.

## Requisitos

- Node.js 24 LTS.
- MySQL ou MariaDB.
- Conta SMTP para recuperação, convites e notificações por e-mail.

## Uso local

1. Copie `.env.example` para `.env` e preencha banco, dados públicos e e-mail.
2. Defina um `SETUP_TOKEN` longo, usado apenas para a primeira conta.
3. Execute:

   ```powershell
   npm.cmd install
   npm.cmd run build
   npm.cmd run migrate
   npm.cmd start
   ```

4. Abra `http://localhost:3001` e `http://localhost:3001/painel`.

Se ainda não houver usuário, o painel mostrará **Criar primeira conta**. Depois disso, novas pessoas entram por convite enviado pela administradora.

## E-mail e troca de senha

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` e `NOTIFICATION_EMAIL`. Para Gmail, use uma senha de app, nunca a senha normal da conta.

O sistema nunca mostra nem devolve o link de redefinição na tela: ele é enviado exclusivamente ao e-mail cadastrado. No painel, abra **Configuração** e use **Enviar e-mail de teste**.

## Segurança e privacidade

- `.env`, backups, `node_modules` e dados reais não são versionados.
- Senhas usam `scrypt` com salt individual; tokens são armazenados somente como hash.
- Cookies de sessão são `HttpOnly`, `SameSite=Strict` e `Secure` em produção.
- Mutações do painel exigem token CSRF e as reservas são garantidas por chave única no banco.
- O formulário público pede apenas dados administrativos e orienta a não enviar exames ou detalhes clínicos.

Este produto organiza site, agenda, pacientes e financeiro básico. Ele não substitui prontuário odontológico certificado, odontograma, prescrição, assinatura digital ou guarda regulatória de documentos clínicos. Esses módulos exigem validação profissional, jurídica e de segurança específica antes de armazenar dados de saúde detalhados.

## Verificação

```powershell
npm.cmd run check
npm.cmd run build
```

## Publicação

Leia `DEPLOYMENT.md`. O GitHub guarda o código, mas a operação também precisa de hospedagem Node.js, MySQL persistente, domínio HTTPS e remetente de e-mail. Em produção o servidor falha de propósito se HTTPS, origem permitida, banco protegido ou SMTP estiverem incompletos.
