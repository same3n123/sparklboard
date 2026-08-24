/* =====================================================================
   SparkBoard Assistant service
   ---------------------------------------------------------------------
   One endpoint. It takes the sentence a learner typed, plus a small
   read-only snapshot of their canvas, and returns:

     { reply, bullets[], actions[] }

   Each action is { op, text } — the op names the operation outright, so no
   interpreter has to guess at the model's English. The browser dispatches
   each op straight to the block command that already exists, and those
   commands still validate: the model never touches the canvas directly and
   can never invent a connection the simulator would refuse.

   The API key lives here, in the environment, and never reaches the page.
   ===================================================================== */
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-5';
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
  required: ['reply', 'bullets', 'actions'],
  properties: {
    /* No maxItems — structured outputs rejects it on arrays. The limits are
       stated here in words and enforced for real when the reply is read. */
    reply:    { type: 'string',
                description: 'What you say to the learner: one to three plain sentences, ' +
                             'warm and specific. This is the whole conversation, so it must ' +
                             'read like a person talking, never a status label.' },
    bullets:  { type: 'array', items: { type: 'string' },
                description: 'At most FOUR extra lines — the why, the numbers, what to try ' +
                             'next. Leave empty when the reply already said everything.' },
    actions:  { type: 'array',
                description: 'What to DO on the canvas, in order. Empty for a pure answer.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['op', 'text'],
                  properties: {
                    op:   { type: 'string', description: 'The action name, from the OPS list.' },
                    text: { type: 'string',
                            description: 'The detail this op needs, in plain words — the part ' +
                                         'names, the number, the condition. See each op.' }
                  }
                } }
  }
};

/* The command grammar the browser can actually execute. Anything outside
   this list is dropped by the page, so it is stated plainly here. */
const GRAMMAR = [
  'THE OPS YOU MAY USE. Each action is {op, text}. The op decides what happens;',
  'the text carries the detail. Nothing re-reads your English, so the op must be exact.',
  '',
  '  op            text should say                    example text',
  '  ----------------------------------------------------------------------------',
  '  add           the part(s), with counts           "two wheels and a chassis"',
  '  connect       two parts, mechanically            "wheel to motor"',
  '  wire          two parts, electrically            "led to the arduino"',
  '  connect_all   (nothing)                          ""',
  '  finish        (nothing) adds driver/battery,     ""',
  '                wires the rest, gives a first step',
  '  remove        the part                           "the second wheel"',
  '  detach        the part to unbolt                 "the wheel"',
  '  unwire        the part to unwire                 "the led"',
  '  set           a motor and a speed                "the motor at 80%"',
  '  move          a servo and an angle               "the servo to 90 degrees"',
  '  on            what to switch on                  "the led"',
  '  off           what to switch off                 "the buzzer"',
  '  stopmotor     the motor to stop                  "the motor"',
  '  reverse       the motor to reverse               "the motor"',
  '  when          the FULL sentence, condition first "when it gets dark turn on the led"',
  '  wait          how long                           "2 seconds"',
  '  repeat        how many times (rarely wanted)     "3 times"',
  '  recipe        a whole project by name            "night light"',
  '  tidy          (nothing) organises the canvas     ""',
  '  run           (nothing) starts the simulation    ""',
  '  stopsim       (nothing) stops it                 ""',
  '  undo          (nothing)                          ""',
  '  status        (nothing) reads the rule engine    ""',
  '  ideas         (nothing) suggests projects        ""',
  '',
  'WHOLE PROJECTS for op "recipe": night light, car, robot, alarm, fan, traffic light,',
  'door, thermometer, distance meter, blinker, button light, machine.',
  '',
  'CONDITIONS for op "when": it gets dark / it is bright / it is hot / it is cold /',
  'something is close / it is loud / it is quiet / the button is pressed / motion is',
  'detected. Write the whole sentence, e.g. "when something is close turn on the buzzer".',
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
  'You are the SparkBoard assistant — a friendly, knowledgeable helper sitting beside a',
  'learner who is building something. SparkBoard is a browser STEM lab where they build a',
  'real circuit or machine on a canvas, program it with blocks, and run an analog',
  'simulation. Its motto is Build -> Break -> Understand -> Fix.',
  '',
  'YOU ARE A CHAT ASSISTANT FIRST. Every message a learner types comes to you, including',
  'greetings, half-formed ideas, questions, and thinking out loud. Reply the way a good',
  'teacher would: talk to them properly, then act. Never answer with a bare status label.',
  '',
  'You do not touch the canvas yourself. You translate what the learner wants into',
  'SparkBoard actions, which the page runs through its own rule engine. If an action',
  'is impossible the page refuses it and says so — that is expected and correct, so never',
  'claim a connection is made, only that you are setting it up.',
  '',
  GRAMMAR,
  '',
  'HOW TO ANSWER',
  '- "reply" is one to three real sentences in a warm, plain voice. Say what you understood',
  '  and what you are doing about it. "Nice — a night light needs to sense darkness, so I am',
  '  adding an LDR and an LED and wiring them to the Arduino." NOT "Building a night light."',
  '- Talk about THEIR build, using the part names on their canvas. If they have two motors',
  '  and a chassis, say so — it shows you actually looked.',
  '- Emit actions whenever they want something built, joined, changed or run. Order them',
  '  the way a person would: add the parts, then join them, then the behaviour.',
  '- Emit NO actions when they are asking a question, greeting you, or thinking aloud.',
  '  Answer properly instead — a question deserves a real answer, not an action.',
  '- Prefer one "recipe" action over ten small ones when they ask for a whole project.',
  '- After adding parts that belong together, add a "connect_all" or "finish" action so',
  '  the build actually works rather than sitting in pieces.',
  '- If they greet you or ask what you can do, be welcoming: say in a sentence what you can',
  '  build together, and give two or three concrete ideas in bullets.',
  '- "bullets" is at most four short lines — the why, a number that matters, what to try',
  '  next. Plain words a beginner knows. Never mention ages or school grades.',
  '- Never repeat the reply in a bullet. If the reply covered it, send no bullets.',
  '- Never invent an op or a part name that is not listed above. If what they want',
  '  is not possible here, say so in one sentence and offer the nearest thing that is.',
  '- Refer to what is already on their canvas (given below) instead of starting over.',
  '- Never end with a repeat action. The sketch already loops forever, so a repeat that',
  '  nobody asked for just lands on the canvas empty. Only use it if they say "repeat".',
  '- Electrical truth matters: an LED always needs a series resistor, a DC motor needs a',
  '  driver rather than a bare board pin, and an LDR needs a 10k divider to read on an',
  '  analog pin. The page enforces this, but say why when it comes up.',
  '',
  'WHEN THE REQUEST DOES NOT FIT',
  '- If the sentence names a real part or idea but not one this canvas has (e.g. a camera,',
  '  Wi-Fi, a screen beyond LCD/OLED, GPS, a speaker that plays music): say plainly that',
  '  SparkBoard cannot build that, in one sentence — then name the closest part or project',
  '  that IS here and offer it as a command. Never emit a command for the part they asked',
  '  for if it does not exist in the parts list above.',
  '- If the sentence is not about building or wiring anything at all (small talk, a request',
  '  unrelated to circuits or machines, something asking you to act outside SparkBoard):',
  '  say in one sentence that you only help with building on this canvas, and use the',
  '  bullets to suggest two or three things SparkBoard can do ("make a night light",',
  '  "add a motor and a wheel", "what is missing?"). Emit no actions.',
  '- If the sentence is too vague to act on ("make it better", "fix it"): ask ONE clarifying',
  '  question as the reply (still one sentence), and use bullets to give a couple of',
  '  concrete guesses at what they might mean, drawn from what is actually on their canvas.',
  '- If they ask what a part does, why it is needed, or how to wire something — even with',
  '  no request to change the canvas — answer as a teacher would: reply names the part and',
  '  its job in one sentence, bullets give the "why" (what it connects to, what breaks',
  '  without it, a real number if one matters — like 220ohm-1k for an LED resistor, or 10k',
  '  for an LDR divider). Emit no actions for a pure explanation.'
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
    /* server-side refusal fallback ("default") is only documented for Claude
       Opus 5 / Fable 5 — on Sonnet 5 it is untested, so skip the beta rather
       than risk another schema-shaped 400. Refusals are still handled below
       via stop_reason, just without an automatic retry on another model. */
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: history.concat([{
        role: 'user',
        content: 'THIS IS THEIR CANVAS RIGHT NOW\n' +
                 snapshotText(req.body && req.body.canvas) +
                 '\n\nTHEY SAID: ' + message
      }])
    });

    if (r.stop_reason === 'refusal')
      return res.json({
        reply: "That one is outside what I'll help build.",
        bullets: ['Ask about a part, a circuit, or a machine on this canvas instead.'],
        actions: []
      });

    const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let out = null;
    try { out = JSON.parse(text); } catch (e) { out = null; }
    if (!out) return res.json({
      reply: "I couldn't work that one out.",
      bullets: ['Try naming a part directly — "add a motor" or "wire the LED to the Arduino".',
                'Or ask "what is missing?" and I will read the canvas myself.'],
      actions: []
    });

    res.json({
      reply: String(out.reply || '').slice(0, 700),
      bullets: (out.bullets || []).slice(0, 4).map(b => String(b).slice(0, 200)),
      actions: (out.actions || []).slice(0, 10)
        .filter(a => a && a.op)
        .map(a => ({ op: String(a.op).toLowerCase().trim().slice(0, 24),
                     text: String(a.text || '').slice(0, 200) }))
    });
  } catch (err) {
    console.error(err);
    res.status(err && err.status === 429 ? 429 : 502).json({ error: plainError(err) });
  }
});

app.listen(PORT, () => console.log('SparkBoard assistant listening on ' + PORT));
