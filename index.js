/* =====================================================================
   SparkBoard Assistant service
   ---------------------------------------------------------------------
   One endpoint. It takes the sentence a learner typed, plus a small
   read-only snapshot of their canvas, and returns:

     { reply, bullets[], commands[] }

   `commands` are ordinary SparkBoard sentences — "add a motor",
   "connect motor to chassis", "when it gets dark turn on the led".
   The browser runs each one through the SAME deterministic interpreter a
   typed command goes through, so the model never touches the canvas
   directly and can never invent a connection the simulator would refuse.

   The API key lives here, in the environment, and never reaches the page.
   ===================================================================== */
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-opus-5';
/* Comma-separated list of sites allowed to call this service, or * for any */
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
/* Optional shared secret — if set, the page must send it as X-App-Token */
const APP_TOKEN = process.env.APP_TOKEN || '';

if (!process.env.ANTHROPIC_API_KEY)
  console.warn('ANTHROPIC_API_KEY is not set — /api/assistant will fail.');

const client = new Anthropic();
const app = express();

app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin: ORIGINS.includes('*') ? true : ORIGINS,
  allowedHeaders: ['Content-Type', 'X-App-Token']
}));

/* ---- a very small rate limit, so one page cannot run up a bill ---- */
const SEEN = new Map();                       /* ip -> timestamps */
const WINDOW = 60000, MAX_PER_WINDOW = Number(process.env.MAX_PER_MINUTE || 20);
function overLimit(ip){
  const now = Date.now();
  const hits = (SEEN.get(ip) || []).filter(t => now - t < WINDOW);
  hits.push(now);
  SEEN.set(ip, hits);
  if (SEEN.size > 5000) SEEN.clear();
  return hits.length > MAX_PER_WINDOW;
}

/* =====================================================================
   What the model is allowed to say back
   ===================================================================== */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'bullets', 'commands'],
  properties: {
    /* No maxItems — structured outputs rejects it on arrays. The limits are
       stated here in words and enforced for real when the reply is read. */
    reply:    { type: 'string', description: 'One short sentence to the learner.' },
    bullets:  { type: 'array', items: { type: 'string' },
                description: 'At most FOUR short lines of reasoning or next steps.' },
    commands: { type: 'array', items: { type: 'string' },
                description: 'At most EIGHT SparkBoard command sentences, in the order they ' +
                             'should run. Empty for a pure answer.' }
  }
};

/* The command grammar the browser can actually execute. Anything outside
   this list is dropped by the page, so it is stated plainly here. */
const GRAMMAR = [
  'COMMANDS YOU MAY EMIT (each string must read like one of these):',
  '',
  '  add a <part>                  "add a motor", "add two wheels and a chassis"',
  '  connect <part> to <part>      mechanical join   ("connect wheel to motor")',
  '  wire <part> to <part>         electrical join   ("wire the led to the arduino")',
  '  connect everything            joins every pair that fits',
  '  finish it                     adds a missing driver/battery and wires the rest',
  '  remove the <part>             deletes it',
  '  detach the <part>             undoes a mechanical join',
  '  unwire the <part>             removes its wires',
  '  run the motor at 80%          sets a motor speed',
  '  move the servo to 90 degrees  sets a servo angle',
  '  turn on the led   /   turn off the buzzer',
  '  stop the motor',
  '  reverse the motor',
  '  wait 2 seconds',
  '  repeat 3 times      (rarely useful — see the rule below)',
  '  when it gets dark turn on the led',
  '      other conditions: when it is bright / hot / cold / something is close /',
  '      it is loud / it is quiet / the button is pressed / motion is detected',
  '  make a night light            whole project. Also: car, robot, alarm, fan,',
  '                                traffic light, door, thermometer, distance meter',
  '  tidy up                       organises the canvas',
  '  run it                        starts the simulation',
  '  stop the simulation',
  '  undo',
  '  what is missing?              reads the rule engine',
  '  what should i build?',
  '',
  'PARTS YOU MAY NAME (use these everyday words):',
  '  led, rgb led, buzzer, lcd, oled, motor, dc motor, servo, stepper, fan, propeller,',
  '  wheel, caster, axle, gear, pulley, belt, chassis, platform, beam, bracket,',
  '  motor mount, gripper, arm, hinge, lever, spring, crank, cam, linkage, conveyor,',
  '  arduino, nano, esp32, breadboard, motor driver, l298n, a4988, relay, transistor,',
  '  mosfet, diode, resistor, button, switch, potentiometer, joystick, keypad, rfid,',
  '  battery, coin cell, battery pack, ldr, temperature sensor, ultrasonic, pir'
].join('\n');

const SYSTEM = [
  'You are the SparkBoard assistant. SparkBoard is a browser STEM lab where school',
  'learners build a real circuit or machine on a canvas, program it with blocks, and run',
  'an analog simulation. Its motto is Build -> Break -> Understand -> Fix.',
  '',
  'You do not touch the canvas. You translate what the learner said into SparkBoard',
  'commands, which the page then runs through its own rule engine. If a command is',
  'impossible the page refuses it and says so — that is expected and correct, so never',
  'claim a connection is made, only that you are trying it.',
  '',
  GRAMMAR,
  '',
  'HOW TO ANSWER',
  '- Emit commands whenever the learner wants something built, joined, changed or run.',
  '  Order them the way a person would: add the parts, then join them, then behaviour.',
  '- Emit NO commands when they are asking a question ("why does my LED need a',
  '  resistor?"). Answer it in reply + bullets instead.',
  '- "reply" is ONE short sentence. Never more.',
  '- "bullets" is at most four short lines — the reason, or what to try next. Plain words',
  '  a beginner knows. Never mention ages or school grades.',
  '- Never invent part names or command forms that are not listed above. If what they want',
  '  is not possible here, say so in one sentence and offer the nearest thing that is.',
  '- Refer to what is already on their canvas (given below) instead of starting over.',
  '- Never end with a repeat block. The sketch already loops forever, so a repeat that',
  '  nobody asked for just lands on the canvas empty. Only emit one if they say "repeat".',
  '- Electrical truth matters: an LED always needs a series resistor, a DC motor needs a',
  '  driver rather than a bare board pin, and an LDR needs a 10k divider to read on an',
  '  analog pin. The page enforces this, but say why when it comes up.'
].join('\n');

function snapshotText(c){
  if (!c || typeof c !== 'object') return 'The canvas is empty.';
  const parts = Array.isArray(c.parts) ? c.parts : [];
  const lines = [];
  lines.push(parts.length
    ? 'Parts on the canvas: ' + parts.map(p => p.name || p.type).join(', ')
    : 'The canvas is empty.');
  if (Array.isArray(c.joined) && c.joined.length)
    lines.push('Already bolted together: ' + c.joined.join('; '));
  if (c.wires) lines.push('Wires: ' + c.wires);
  if (Array.isArray(c.blocks) && c.blocks.length)
    lines.push('Blocks already made: ' + c.blocks.join(', '));
  if (c.status) lines.push('The page says: ' + c.status);
  if (Array.isArray(c.problems) && c.problems.length)
    lines.push('Rule engine warnings: ' + c.problems.join('; '));
  return lines.join('\n');
}

/* Anything that goes wrong upstream becomes one sentence a learner can read.
   The raw API text is still in the Render log, where it belongs. */
function plainError(err){
  const msg = String((err && err.message) || '');
  const code = (err && err.status) || 0;
  if (/credit balance/i.test(msg))
    return 'The assistant account is out of credit — a teacher needs to top it up.';
  if (code === 401 || code === 403 || /authentication|api key/i.test(msg))
    return 'The assistant service has no working key set up.';
  if (code === 429)
    return 'Too many questions at once — wait a few seconds and ask again.';
  if (code >= 500)
    return 'The assistant is busy right now. Try again in a moment.';
  return 'The assistant could not answer that one.';
}

/* A plain word at the root, so opening the address in a browser says something. */
app.get('/', (_req, res) => res.type('text').send([
  'SparkBoard assistant is running.',
  '',
  'There is no home page here. Health check:  /health',
  'SparkBoard talks to it at:                 POST /api/assistant',
  ''
].join('\n')));

app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL }));

app.post('/api/assistant', async (req, res) => {
  if (APP_TOKEN && req.get('X-App-Token') !== APP_TOKEN)
    return res.status(401).json({ error: 'Bad app token.' });

  const ip = req.get('x-forwarded-for') || req.ip || 'anon';
  if (overLimit(ip))
    return res.status(429).json({ error: 'Too many questions in a minute — wait a moment.' });

  const message = String((req.body && req.body.message) || '').slice(0, 2000).trim();
  if (!message) return res.status(400).json({ error: 'No message.' });

  /* the last few turns, so "do that again" means something */
  const raw = (req.body && Array.isArray(req.body.history)) ? req.body.history : [];
  const history = raw.slice(-6)
    .filter(m => m && m.text)
    .map(m => ({ role: m.role === 'you' ? 'user' : 'assistant',
                 content: String(m.text).slice(0, 1000) }));

  try {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: history.concat([{
        role: 'user',
        content: 'THIS IS THEIR CANVAS RIGHT NOW\n' +
                 snapshotText(req.body && req.body.canvas) +
                 '\n\nTHEY SAID: ' + message
      }])
    });

    if (r.stop_reason === 'refusal')
      return res.json({ reply: 'I cannot help with that one.', bullets: [], commands: [] });

    const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let out = null;
    try { out = JSON.parse(text); } catch (e) { out = null; }
    if (!out) return res.json({ reply: 'I could not work that out.', bullets: [], commands: [] });

    res.json({
      reply: String(out.reply || '').slice(0, 300),
      bullets: (out.bullets || []).slice(0, 4).map(b => String(b).slice(0, 200)),
      commands: (out.commands || []).slice(0, 8).map(c => String(c).slice(0, 200))
    });
  } catch (err) {
    console.error(err);
    res.status(err && err.status === 429 ? 429 : 502).json({ error: plainError(err) });
  }
});

app.listen(PORT, () => console.log('SparkBoard assistant listening on ' + PORT));
