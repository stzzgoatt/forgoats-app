# Community For Goats • Precision Fix

Aplicativo desktop em Electron integrado ao **Bot For Goats** (Discord) para geração e validação de tokens com vínculo de HWID.

## Integração com o Bot do Discord

O aplicativo valida cadastro, login e sessão contínua diretamente na API de autenticação do `Bot For Goats`:

- `POST /api/auth/register` — cria conta e vincula o token + HWID
- `POST /api/auth/login` — valida usuário, senha, HWID e validade do token
- `POST /api/auth/verify` — verifica periodicamente se o token expirou, foi resetado ou se a conta foi removida

### Comandos no Discord

- `/gerartoken` — gera token `GOATS-XXXX` válido por 30 dias
- `/testetoken` — gera token `TEST-XXXX` válido por 3 minutos
- `/resettoken` — reseta o HWID vinculado a um token

## Configuração da URL da API (`auth-config.json`)

Por padrão, o aplicativo conecta no bot local:

```json
{
  "authApiUrl": "http://127.0.0.1:3001",
  "verifyIntervalMs": 30000,
  "requestTimeoutMs": 8000
}
```

Para usar o aplicativo em outros PCs depois de hospedar o bot (VPS, Cloudflare Tunnel, etc.), basta trocar `"authApiUrl"` em `auth-config.json` para a URL HTTPS do seu servidor (ou definir a variável de ambiente `FORGOATS_AUTH_URL`).

## Desenvolvimento local

```bash
npm install
npm start
```
