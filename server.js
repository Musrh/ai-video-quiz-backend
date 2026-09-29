const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const youtubeRouter = require('./routes/youtube');
const contentRouter = require('./routes/content');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    ok: true,
    app: 'AI Video Quiz Backend',
    version: '1.0.0'
  });
});

app.use('/api/youtube', youtubeRouter);
app.use('/api/youtube', contentRouter);

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'AI Video Quiz backend running on port ' + PORT
  );
});
