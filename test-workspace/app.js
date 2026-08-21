const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

function getWelcomeTitle() {
  return 'Hello Agent';
}

app.get('/', (req, res) => {
  const title = getWelcomeTitle();
  res.send(`<h1>${title}</h1>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});