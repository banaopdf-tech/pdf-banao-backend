FROM node:20-bookworm-slim

# LibreOffice (Writer/Calc/Impress/Draw only — not the full metapackage,
# keeps the image smaller) for Office<->PDF conversion, qpdf for PDF
# password protect/unlock, and Liberation/DejaVu fonts so documents using
# common MS-Office fonts (Arial/Times/Courier) render correctly instead of
# silently substituting a wrong-width fallback font.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    qpdf \
    fonts-liberation \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
