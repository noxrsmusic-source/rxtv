# Node.js ka official image use karein
FROM node:20-slim

# Chromium aur uski zaroori Linux libraries install karein
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer ko batayein ki system wala Chromium use kare
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Dependencies copy aur install karein
COPY package*.json ./
RUN npm install

# Baaki ka code copy karein
COPY . .

EXPOSE 3000

CMD ["npm", "start"]