# AGENTS.md — NTI Sentinel

## Stack
- **Backend**: Node.js + Express + Sequelize + SQLite + Socket.IO + Passport.js
- **Frontend**: HTML + Bootstrap 5 + Chart.js + jsPDF (sem framework, sem build step)

## Comandos
- **Instalar**: `npm install`
- **Rodar (dev)**: `node server.js` ou `npm start`
- **Rodar (prod)**: `NODE_ENV=production node server.js` ou `pm2 start ecosystem.config.js --env production`
- **Docker**: `docker build -t nti-sentinel . && docker run -p 3000:3000 -v $(pwd)/data:/app/data nti-sentinel`

## Configuração
- Copie `.env.example` para `.env` e ajuste os valores
- **SESSION_SECRET**: gerar com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- O Dev inicial é criado no primeiro boot com `ADMIN_USER`/`ADMIN_SENHA` do `.env`

## Arquitetura
- `server.js` — único arquivo de backend (rotas, modelos, auth, cron)
- `public/` — frontend estático servido pelo Express
- `database.sqlite` — banco (gitignored)
- `logs/{ano}/` — CSVs de arquivamento diário (gitignored)

## Segurança
- Autenticação server-side via Passport + bcrypt + express-session
- 3 roles: `dev` > `operador` > `gestor`
- Middlewares: `isAuth`, `isStaff`, `isManager`, `isDev`
- Rate-limit nas rotas públicas: login (5/min), ticket (10/h), registro (5/h)
- XSS: função `esc()` em todos os HTMLs que inserem dados do usuário no DOM
- Cookies: `httpOnly`, `secure` em produção, `sameSite: 'lax'`
- Input sanitizado no backend (`sanitizar()`) com limite de tamanho

## Lint / Typecheck
- Não há lint configurado. Se adicionar, use `eslint` com `--ext .js`.
- Não há typecheck (projeto em JS puro).

## Testes
- Não há testes automatizados. Para adicionar: `npm i -D jest supertest` e criar `tests/`.

## Notas
- SQLite é adequado para uso local/monousuário. Para multiusuário concorrente, migrar para PostgreSQL (basta trocar `dialect` no Sequelize).
- O cron das 07:00 arquiva tickets resolvidos em CSV e limpa o banco.
- Dependências com vulnerabilidades residuais (sequelize/sqlite3) requerem upgrade major para fix completo.
