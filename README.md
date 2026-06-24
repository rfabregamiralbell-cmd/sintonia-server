# SINTONÍA — Servidor de producción

Cuentas + sesión (JWT), **uso por usuario con +mantenimiento**, **BYOK**, y **emisoras en la nube**. Pensado para iOS y Android.

## Endpoints
- `POST /auth/apple` · `POST /auth/google` — el móvil manda el **idToken** nativo; el servidor lo verifica y devuelve `{ token, email }` (JWT propio, 60 días).
- `POST /auth/dev` — login por email **solo para pruebas** (`ALLOW_DEV_AUTH=1`).
- `POST /commentary` *(sesión)* — comentario del locutor. Si llega cabecera `x-user-key` (BYOK) usa esa clave y **no cobra**; si no, usa la clave incluida, **aplica +MARKUP** y descuenta del presupuesto del usuario.
- `GET /me/usage` · `POST /me/budget` · `POST /me/reset` *(sesión)* — uso/presupuesto por usuario.
- `POST /stations` *(sesión)* — publica la emisora actual `{ payload, public? }` → `{ id }`.
- `GET /stations?q=&tag=&sort=recent|popular` — explorar públicas (sin sesión).
- `GET /stations/:id` — descargar payload para importar (sin sesión).
- `DELETE /stations/:id` *(sesión, dueño)*.

## Arranque local
```bash
cd SintoniaServer
cp .env.example .env          # pon ANTHROPIC_KEY y JWT_SECRET
npm install
npm run dev                   # http://localhost:8787
```
Base de datos: SQLite en `DB_PATH` (fichero local). Para escalar, se puede migrar a Postgres manteniendo el mismo esquema.

## Desplegar (para que funcione en el móvil de verdad)
Cualquier host con Node + disco para SQLite (Render, Railway, Fly.io, un VPS…):
1. Variables de entorno = las de `.env.example` (con `ALLOW_DEV_AUTH=0`).
2. `npm run build && npm start`.
3. Te dan una **URL HTTPS** (p. ej. `https://api.tudominio.com`). Esa es la que usa la app.
4. better-sqlite3 compila nativo en el host; si usas contenedor, instala build-essential/python3.

## Conectar la app (Flutter)
En `lib/api.dart` y `lib/cloud.dart`, pon `baseUrl` a tu URL HTTPS (o pásalo por configuración). La app ya:
- guarda el **token** de sesión cifrado y lo manda como `Authorization: Bearer`,
- manda `x-user-key` en modo BYOK,
- tiene `CloudService` para `publish/browse/fetch` emisoras.

## Inicio de sesión nativo (esto es lo que falta cablear en el móvil)
El servidor ya **verifica** los idToken; en la app hay que **obtenerlos** con los plugins nativos y mandarlos a `/auth/apple|google`:

### iOS — Sign in with Apple
1. En Xcode: capability **Sign in with Apple**.
2. Plugin `sign_in_with_apple`. Obtén `credential.identityToken` y llama:
   `state.cloudLoginProvider('apple', identityToken)`.
3. `APPLE_CLIENT_ID` = el **Bundle ID** (o Service ID) de la app.

### Android / iOS — Google Sign-In
1. Crea credenciales OAuth (Google Cloud) para Android (SHA-1) y/o iOS.
2. Plugin `google_sign_in`. Obtén `googleAuth.idToken` y llama:
   `state.cloudLoginProvider('google', idToken)`.
3. `GOOGLE_CLIENT_ID` = el **OAuth Client ID** (Web client para verificación del idToken).

> Hasta cablear esos plugins, el botón Apple/Google del onboarding deja la cuenta en local y, si pones email + el servidor tiene `ALLOW_DEV_AUTH=1`, inicia sesión por `/auth/dev` (solo pruebas).

## Seguridad / producción
- `ALLOW_DEV_AUTH=0` en producción (si no, cualquiera entra con un email).
- `JWT_SECRET` largo y secreto; `ANTHROPIC_KEY` nunca llega al cliente.
- Hay **límite por usuario/hora** (`RATE_LIMIT_HOUR`) para proteger la clave incluida.
- Añade copias de seguridad del fichero SQLite.

## Aviso honesto
No se ha compilado/ejecutado aquí. Está escrito con librerías estándar (express, jose, better-sqlite3) y la verificación de Apple/Google es la estándar por JWKS, pero hay que probarlo al desplegar. Cobro real del +15% (facturación/IAP) y moderación de emisoras públicas quedan como siguiente paso.
