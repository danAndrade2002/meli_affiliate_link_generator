FROM ghcr.io/puppeteer/puppeteer:24.43.0

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js createAffiliateLink.js Meli_Login.js db.js ./

RUN chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 3000
CMD ["node", "server.js"]
