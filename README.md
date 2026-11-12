# Locutor · web y servidor

Web pública (https://locutor.onrender.com) y servidor de las apps Locutor (Windows y Android).

- `public/` — la web en 5 idiomas (es, en, ar, hi, zh), términos y privacidad, demo.
- `src/` — servidor Node/TypeScript: plan y pagos (Stripe, Google), datos de canciones y puente de voz.
- Publicar = `git push` a `main` (Render despliega solo). Para no desplegar, pon `[skip render]` en el mensaje del commit.
- Variables y secretos: en el panel de Render (lista en `.env.example` y `render.yaml`).

Arranque local: `npm install && npm run build && npm start`.
