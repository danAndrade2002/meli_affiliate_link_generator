FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js createAffiliateLink.js Meli_Login.js db.js ./

EXPOSE 3000
CMD ["node", "server.js"]
