# Backend de SINTONÍA — Node + Express + better-sqlite3
# Imagen con herramientas de compilación por si better-sqlite3 compila nativo.
FROM node:20-slim

# Dependencias de build para módulos nativos (better-sqlite3) si no hay prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependencias primero (mejor caché)
COPY package*.json ./
RUN npm install

# Copia el código y compila TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# PORT y DB_PATH los controla el host (Render inyecta PORT; DB_PATH como variable
# de entorno: /tmp/sintonia.db para prueba sin disco, /data/sintonia.db con disco).
EXPOSE 8787

CMD ["node", "dist/index.js"]
