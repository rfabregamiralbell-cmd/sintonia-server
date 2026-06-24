# Detección de canciones — tres fuentes

En "En antena" puedes elegir cómo capta SINTONÍA la canción. Cada fuente tiene un
comportamiento distinto:

| Fuente | Qué hace | Comentario | Plataformas |
|---|---|---|---|
| **Sistema** | Lee los metadatos de lo que reproduce el móvil | Voz (según tu config) | iOS/Android/Windows/Linux (puentes nativos) |
| **API** | Pregunta a tu servicio "qué suena ahora" | **Voz tipo duck** (habla encima) | Cualquiera con red (Spotify hoy) |
| **Ambiente** | Graba por el micro e identifica (estilo Shazam) | **Solo texto** | iOS/Android (micro) |

## Sistema (lo que ya teníamos)
Lee la sesión multimedia del SO (MediaSession en Android, MediaPlayer en iOS, SMTC en
Windows, MPRIS en Linux). No "oye" nada: solo ve los metadatos que publica la app que
reproduce. Es lo más fiel y sin coste, pero necesita los puentes nativos por plataforma.

## API (Spotify hoy; Apple Music con MusicKit)
- **Spotify**: `GET /v1/me/player/currently-playing` con un *access token* del usuario.
  Implementado en `lib/service_detect.dart` (sondea cada ~10 s). El token se obtiene con
  **OAuth (Authorization Code + PKCE)**: registra la app en el dashboard de Spotify, define
  el *redirect URI* (deep link), y captura el token. Hoy hay un atajo de desarrollo: pegar
  el token a mano en "Conectar Spotify". Cámbialo por el flujo OAuth real para producción.
- **Apple Music**: usa **MusicKit** (nativo). Hay que pedir el *user token* con
  `MusicAuthorization` y consultar el reproductor; eso es un puente nativo, no Dart.
- Ventajas: uniforme entre plataformas, abre incluso la web. Límites: requiere login del
  servicio, hay latencia (sondeo) y cuotas de la API.
- Comportamiento: al cambiar de canción, el locutor **habla por encima de la música (duck)**.

## Ambiente — "Shazam" (reconocimiento por micrófono)
No existe en Flutter puro. Dos caminos:
1. **ShazamKit** (Apple): reconocimiento **en el dispositivo**, gratis, pero es nativo y por
   plataforma (iOS/macOS; hay variante Android). No pasa por el backend.
2. **Servicio de reconocimiento en la nube** (lo implementado): la app graba ~6 s con el
   micro (`lib/recognize.dart`, plugin `record`), manda el audio al backend `/recognize`,
   y el backend consulta **AudD** (`api.audd.io`, `AUDD_TOKEN`) o ACRCloud. Devuelve título y
   artista. Es de pago/limitado pero uniforme entre plataformas.
- Permisos de micrófono:
  - iOS `Info.plist`: `NSMicrophoneUsageDescription` con un texto.
  - Android `AndroidManifest.xml`: `<uses-permission android:name="android.permission.RECORD_AUDIO"/>`.
- Comportamiento: el comentario es **solo texto** (no habla), como pediste.

## Web
- **Sistema**: imposible (el navegador no ve lo que reproducen otras apps).
- **API**: sí (Spotify Web API con OAuth).
- **Ambiente**: posible con micro del navegador, pero el plugin `record` y los permisos web
  varían; no es el foco.

> Honestidad: la arquitectura está en Dart y el endpoint en el backend, pero **no compilado/probado**
> aquí. Faltan por tu parte: OAuth de Spotify (o pegar token en dev), MusicKit si quieres Apple
> Music, la clave `AUDD_TOKEN` (o integrar ShazamKit), y los permisos de micrófono en iOS/Android.
> Revísalo en Antigravity.
