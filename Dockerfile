FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
