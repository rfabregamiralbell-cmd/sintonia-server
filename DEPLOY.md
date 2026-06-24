# Despliegue del backend y cobro (+15 % mant.)

## 1. Desplegar el servidor (para tener una URL con HTTPS)

El backend está en `SintoniaServer/`. Opciones fáciles: **Render**, **Railway** o **Fly.io**.

Pasos generales:
1. Sube `SintoniaServer/` a un repo Git.
2. Crea un servicio web Node. Build: `npm install && npm run build`. Start: `npm start`.
3. Variables de entorno: copia las de `.env.example` y rellénalas (ver abajo).
4. Persistencia: SQLite necesita un **disco persistente** (Render Disk / Railway Volume) montado
   donde apunte `DB_PATH` (p. ej. `/data/sintonia.db`). Sin disco, la BD se borra en cada deploy.
5. Al desplegar obtienes una URL `https://...`. Ponla en la app:
   `lib/api.dart` → `baseUrl` y `lib/cloud.dart` → `baseUrl`.

> En `localhost` (sin HTTPS) Apple/Google/Stripe no funcionan del todo. Despliega para probar de verdad.

## 2. Modelo de cobro

- **IA incluida**: requiere **plan activo** (suscripción). El servidor bloquea `/commentary`
  con `402 {error:"subscription"}` si no hay plan (lo gestiona `REQUIRE_SUBSCRIPTION=1`).
- **BYOK (clave propia)**: nunca requiere plan; el usuario paga a su proveedor.
- El **+15 %** se sigue calculando sobre el coste del proveedor y se muestra en "Control de costes"
  como transparencia; el ingreso real entra por la suscripción.

## 3. Stripe (web / escritorio / Android sin tienda)

1. Crea un **producto** con un **precio recurrente** (mensual) → copia el `price_...` en `STRIPE_PRICE_ID`.
2. `STRIPE_SECRET` = tu clave secreta (`sk_live_...` o `sk_test_...`).
3. Crea un **webhook** apuntando a `https://TU_BACKEND/billing/webhook` con los eventos
   `customer.subscription.created/updated/deleted` → copia el secreto `whsec_...` en `STRIPE_WEBHOOK_SECRET`.
4. `APP_BASE_URL` = dominio para las URLs de éxito/cancelación del Checkout.

Flujo en la app: **Tú → Activar plan** llama a `/billing/checkout`, abre la URL de Stripe en el
navegador; al pagar, Stripe llama al webhook y el usuario queda `subscribed`. "Actualizar estado"
relee `/billing/status`.

> Importante (política de tiendas): en **iOS**, vender funciones digitales con un método de pago
> externo (Stripe) suele **incumplir** las reglas de App Store. En iOS usa **IAP de Apple**; deja
> Stripe para web/escritorio/Android (y revisa también la política de Google Play).

## 4. App Store (iOS) — IAP

1. En App Store Connect crea una **suscripción auto-renovable** (product ID, p. ej. `sintonia.monthly`).
2. Genera el **App-Specific Shared Secret** → `APPLE_SHARED_SECRET`.
3. En la app, con el plugin `in_app_purchase`, compra el producto y obtén el **receipt** (base64).
4. Envía el receipt a `POST /billing/apple {receipt}`. El servidor lo valida con Apple y marca el plan.

> El endpoint usa `verifyReceipt` (válido para auto-renovables). Si migras a **StoreKit 2**,
> verifica el `JWS` de la transacción con las claves de Apple (App Store Server API) — cambia
> `verifyApple` en `billing.ts` por esa verificación.

## 5. Google Play (Android) — IAP

1. Crea la **suscripción** en Play Console (product ID).
2. Crea una **cuenta de servicio** con acceso a **Android Publisher** y descarga su JSON →
   `GOOGLE_SERVICE_ACCOUNT_JSON` (en una sola línea). `GOOGLE_PACKAGE_NAME` = package de la app.
3. En la app, compra con `in_app_purchase` y obtén el `purchaseToken`.
4. Envía `POST /billing/google {purchaseToken, productId}`. El servidor valida con la API y marca el plan.

## 6. IAP en la app (ya cableado)

La app ya integra `in_app_purchase` (`lib/iap.dart`): en **iOS/Android**, "Activar plan" lanza la
compra real del producto `sintonia.monthly`; al completarse, manda el receipt/token a
`/billing/apple` o `/billing/google` (verificación en servidor ya hecha) y refresca el estado.
En **web/escritorio** (sin tienda) cae automáticamente a **Stripe Checkout**.

Lo que falta por tu parte: crear el producto `sintonia.monthly` en App Store Connect y Play Console
(mismo product ID), configurar los secretos del backend (`APPLE_SHARED_SECRET`,
`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_PACKAGE_NAME`) y, en iOS, añadir la capability de
In-App Purchase en Xcode.

## Resumen de variables (.env)

| Variable | Para qué |
|---|---|
| `ANTHROPIC_KEY` | Clave de la IA incluida |
| `JWT_SECRET` | Firmar sesiones |
| `MARKUP` | % mantenimiento (0.15) |
| `REQUIRE_SUBSCRIPTION` | 1 = exigir plan para IA incluida |
| `STRIPE_SECRET` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET` / `APP_BASE_URL` | Stripe |
| `APPLE_SHARED_SECRET` | Validar receipts de iOS |
| `GOOGLE_PACKAGE_NAME` / `GOOGLE_SERVICE_ACCOUNT_JSON` | Validar compras de Android |
| `APPLE_CLIENT_ID` / `GOOGLE_CLIENT_ID` | Verificar el login nativo |
| `ALLOW_DEV_AUTH` | Login por email (solo dev) |
| `DB_PATH` / `PORT` | SQLite y puerto |

> Honestidad: nada de esto se compila ni se prueba aquí. El código está escrito contra las APIs
> estables de Stripe, App Store y Google Play, pero la configuración (productos, precios, webhooks,
> cuentas de servicio, capacidades) hay que hacerla en cada panel, y el backend hay que desplegarlo.
> Revísalo y pruébalo en Antigravity / en tu hosting.
