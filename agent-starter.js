require('dotenv').config();
const axios = require('axios');

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.AGENT_MAX_RETRIES || 2);

const CONFIG = {
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  deepsea: {
    baseUrl: process.env.DEEPSEA_BASE_URL,
    apiKey: process.env.DEEPSEA_API_KEY,
    model: process.env.DEEPSEA_MODEL || 'deepsea-coder-latest',
  },
  replit: {
    baseUrl: process.env.REPLIT_BASE_URL,
    apiKey: process.env.REPLIT_API_KEY,
    replId: process.env.REPLIT_REPL_ID,
  },
  maxSteps: Number(process.env.AGENT_MAX_STEPS || 8),
  runReplitStep: process.env.EXECUTE_REPLIT_STEP === 'true',
};

function trimSlash(url) {
  return (url || '').replace(/\/$/, '');
}

function assertUrl(name, value) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL. Received: ${value}`);
  }
}

function mustHaveConfig() {
  const required = [
    ['OPENAI_API_KEY', CONFIG.openai.apiKey],
    ['OPENAI_BASE_URL', CONFIG.openai.baseUrl],
    ['DEEPSEA_API_KEY', CONFIG.deepsea.apiKey],
    ['DEEPSEA_BASE_URL', CONFIG.deepsea.baseUrl],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  assertUrl('OPENAI_BASE_URL', CONFIG.openai.baseUrl);
  assertUrl('DEEPSEA_BASE_URL', CONFIG.deepsea.baseUrl);

  if (CONFIG.runReplitStep) {
    const replitMissing = [
      ['REPLIT_API_KEY', CONFIG.replit.apiKey],
      ['REPLIT_BASE_URL', CONFIG.replit.baseUrl],
      ['REPLIT_REPL_ID', CONFIG.replit.replId],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (replitMissing.length) {
      throw new Error(
        `EXECUTE_REPLIT_STEP=true, but required Replit variables are missing: ${replitMissing.join(', ')}`
      );
    }

    assertUrl('REPLIT_BASE_URL', CONFIG.replit.baseUrl);
  }
}

async function withRetries(label, fn) {
  let attempt = 0;
  let lastError;

  while (attempt <= MAX_RETRIES) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) {
        break;
      }
      const waitMs = 400 * (attempt + 1);
      console.warn(`${label} failed (attempt ${attempt + 1}). Retrying in ${waitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    attempt += 1;
  }

  throw lastError;
}

async function requestChatCompletion({ baseUrl, apiKey, model, messages, temperature }) {
  const url = `${trimSlash(baseUrl)}/chat/completions`;

  const response = await withRetries(`POST ${url}`, async () =>
    axios.post(
      url,
      {
        model,
        messages,
        temperature,
      },
      {
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    )
  );

  return response.data.choices?.[0]?.message?.content?.trim() || '';
}

async function callOpenAI(messages) {
  return requestChatCompletion({
    baseUrl: CONFIG.openai.baseUrl,
    apiKey: CONFIG.openai.apiKey,
    model: CONFIG.openai.model,
    messages,
    temperature: 0.2,
  });
}

async function callDeepSeaCoder(prompt) {
  return requestChatCompletion({
    baseUrl: CONFIG.deepsea.baseUrl,
    apiKey: CONFIG.deepsea.apiKey,
    model: CONFIG.deepsea.model,
    messages: [
      { role: 'system', content: 'You are a precise coding assistant.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
  });
}

async function runInReplit({ replId, command }) {
  const url = `${trimSlash(CONFIG.replit.baseUrl)}/repls/${replId}/run`;

  const response = await withRetries(`POST ${url}`, async () =>
    axios.post(
      url,
      { command },
      {
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${CONFIG.replit.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    )
  );

  return response.data;
}

function chooseProvider(task) {
  const codeKeywords = [
    'code',
    'function',
    'bug',
    'refactor',
    'test',
    'script',
    'api integration',
    'implementation',
  ];
  const normalized = task.toLowerCase();
  return codeKeywords.some((word) => normalized.includes(word)) ? 'deepsea-coder' : 'gpt';
}

function extractSteps(planText) {
  if (!planText) {
    return [];
  }

  const rawLines = planText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const numbered = rawLines
    .filter((line) => /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s+/, '').trim());

  if (numbered.length > 0) {
    return numbered;
  }

  const bullets = rawLines
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim());

  if (bullets.length > 0) {
    return bullets;
  }

  return rawLines.slice(0, 6);
}

async function agentLoop(userGoal) {
  const plannerPrompt = [
    {
      role: 'system',
      content:
        'Break user goals into concise execution steps. Prefer 3-6 numbered items with one action each.',
    },
    { role: 'user', content: `Goal: ${userGoal}` },
  ];

  const plan = await callOpenAI(plannerPrompt);
  console.log('\n=== PLAN ===\n', plan);

  const steps = extractSteps(plan).slice(0, CONFIG.maxSteps);
  if (steps.length === 0) {
    throw new Error('Planner returned no actionable steps.');
  }

  const results = [];

  for (const step of steps) {
    const provider = chooseProvider(step);
    const output =
      provider === 'deepsea-coder'
        ? await callDeepSeaCoder(`Execute this step:\n${step}`)
        : await callOpenAI([
            { role: 'system', content: 'You are an AI operations assistant.' },
            { role: 'user', content: `Execute this step:\n${step}` },
          ]);

    results.push({ step, provider, output: output || '[empty model response]' });
  }

  if (CONFIG.runReplitStep) {
    const command = 'echo "agent execution complete"';
    const replitResult = await runInReplit({ replId: CONFIG.replit.replId, command });
    results.push({
      step: `Run verification command in Replit: ${command}`,
      provider: 'replit',
      output: JSON.stringify(replitResult),
    });
  }

  return { plan, results };
}

async function main() {
  mustHaveConfig();

  const userGoal = process.argv.slice(2).join(' ').trim() ||
    'Build an AI agent that can plan tasks, generate code with DeepSea Coder, and run commands via Replit APIs.';

  const { results } = await agentLoop(userGoal);

  console.log('\n=== RESULTS ===');
  for (const item of results) {
    console.log(`\n[${item.provider}] ${item.step}\n${item.output.slice(0, 800)}\n`);
  }

  console.log('\nDone.');
}

main().catch((error) => {
  const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
  console.error('Agent failed:', details);
  process.exit(1);
});
