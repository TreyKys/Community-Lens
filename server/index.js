import express from 'express';
import cors from 'cors';
import { verifyClaim } from './services/aiService.js';
import chalk from 'chalk';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.post('/api/analyze', async (req, res) => {
  const { claim, debug } = req.body;
  console.log(chalk.blue(`\n[Analyze] Received claim: "${claim}"`));

  if (!claim) {
    return res.status(400).json({ error: 'Claim is required' });
  }

  try {
    const result = await verifyClaim(claim, { debug });
    console.log(chalk.green(`[Analyze] Result: TruthScore=${result.aggregate.truthScore}%`));
    res.json(result);
  } catch (error) {
    console.error(chalk.red('[Analyze] Error processing claim:'), error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(chalk.bold(`\n🚀 Server running on port ${PORT}`));
  console.log(`   POST http://localhost:${PORT}/api/analyze`);
});
