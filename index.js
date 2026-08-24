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
/* low is noticeably quicker and fine for this job — translating a sentence into
   actions is not deep reasoning. Set EFFORT=medium or high to think harder. */
const EFFORT = process.env.EFFORT || 'low';

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
  '  pin           ONE wire, both ends named          "U1.13 to LED1.anode"',
  '  unpin         take ONE wire out again            "U1.13 to LED1.anode"',
  '  mount         ONE mechanical joint, points named "PR1.bore to M1.shaft"',
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
  'WIRING — YOU DESIGN THE CIRCUIT',
  'The canvas below lists every part with its real pin names, and every wire that already',
  'exists pin to pin. Use them. Think the circuit through and wire it yourself with "pin":',
  '',
  '  {"op":"pin","text":"U1.13 to LED1.anode"}',
  '',
  'Name the part exactly as the canvas does (U1, LED1, R1) and the pin by its id or its',
  'everyday name — 13, A0, GND, 5V, anode, cathode, +, -. A pin that does not exist is',
  'refused and the real pin list is shown, so nothing silently goes wrong.',
  '',
  'Work out the WHOLE loop before you emit anything. Current has to leave the source, pass',
  'through the part, and get back. A wire to an LED anode with nothing on its cathode is a',
  'dead circuit, and the rule engine will say so.',
  '',
  'READ THE CANVAS BEFORE YOU WIRE ANYTHING',
  'The wire list below is the truth about what is already connected. Before every "pin":',
  '',
  '  1. Is this wire already in the list? Then DO NOT emit it. Say it is already done.',
  '  2. Is the pin I want already used for something else? Pick a free one — a board has',
  '     many digital pins, and two parts fighting over pin 13 is a bug you created.',
  '  3. Am I CHANGING a connection rather than adding one? Then "unpin" the old wire FIRST,',
  '     then "pin" the new one. Adding without removing leaves both, and the circuit is',
  '     then wrong in a way that is hard for a learner to see.',
  '',
  'Moving an LED from pin 13 to pin 9 is two actions, in this order:',
  '  {"op":"unpin","text":"U1.13 to LED1.anode"}',
  '  {"op":"pin","text":"U1.9 to LED1.anode"}',
  '',
  'NAMING PARTS YOU ARE ABOUT TO ADD',
  'Parts are named by type in the order they arrive: the first LED is LED1, the next LED2,',
  'resistors are R1, R2, boards are U1. So after adding one more LED to a canvas that has',
  'LED1, you may wire LED2. Count what is already there before you predict a name.',
  '',
  'CIRCUITS WORTH KNOWING BY HEART',
  '  LED on a board pin:  pin -> LED.anode, LED.cathode -> resistor.1, resistor.2 -> GND.',
  '                       Never a bare LED across a pin; 220ohm to 1k is the resistor.',
  '  LDR (light sensor):  5V -> LDR.1, LDR.2 -> A0, and ALSO A0 -> 10k.1, 10k.2 -> GND.',
  '                       Without that divider A0 floats near 5V and "dark" never happens.',
  '  Button:              pin -> button.1, button.2 -> GND (the code uses the input pullup).',
  '  Buzzer:              pin -> buzzer.+, buzzer.- -> GND.',
  '  DC motor:            NEVER off a board pin. Board -> driver IN pins, driver OUT pins ->',
  '                       motor, battery -> driver power. Use "finish" if a driver is missing.',
  '  Ultrasonic:          5V -> VCC, GND -> GND, a digital pin -> TRIG, another -> ECHO.',
  '',
  'BOLTING THINGS TOGETHER (mechanical, not electrical)',
  'Parts bolt together at POINTS, and the canvas below lists them with their role and kind,',
  'like "bore(plug:shaft)" or "shaft(shaft:shaft)". The rule is simple:',
  '',
  '  a PLUG goes into a SOCKET, or onto a SHAFT, of THE SAME KIND.',
  '',
  'So PR1.bore(plug:shaft) fits M1.shaft(shaft:shaft) — same kind, plug into shaft. It does',
  'NOT fit CH1.left_motor_mount(socket:motor-mount), because the kinds differ.',
  'Use "mount" when you know both points: {"op":"mount","text":"PR1.bore to M1.shaft"}',
  'Use "connect" when you just mean two parts and will let the app pick the points.',
  'A shaft carries MANY riders, so a gear, a wheel and a pulley can all share one axle.',
  '',
  'Worth knowing about this engine: a wheel or propeller mounts DIRECTLY on a motor shaft,',
  'and an axle cannot mount on a motor at all. A motor reaches a chassis through a motor',
  'mount, never directly.',
  '',
  'THE SHORTCUTS, when you want them rather than instead of thinking:',
  '  "connect_all"  joins every pair that fits, using the app\'s own planner.',
  '  "finish"       adds a missing driver or battery and completes what is half-built.',
  '  "recipe"       builds a whole known project, hand-checked and always correct.',
  'Reach for "recipe" when they name a project you know. Reach for "finish" when they ask',
  'you to fix or complete something. Otherwise design it yourself with "pin".',
  '',
  'WHOLE PROJECTS for op "recipe": night light, car, robot, alarm, fan, traffic light,',
  'door, thermometer, distance meter, blinker, button light, machine.',
  '',
  'CONDITIONS for op "when": it gets dark / it is bright / it is hot / it is cold /',
  'something is close / it is loud / it is quiet / the button is pressed / motion is',
  'detected. Write the whole sentence, e.g. "when something is close turn on the buzzer".',
  '',
  'PARTS YOU MAY NAME — use these names EXACTLY. They are matched word for word, so a',
  'name you improvise ("9V battery pack", "LED light strip") lands on the wrong part or',
  'on two parts at once.',
  '',
  '  POWER      9v battery      one rectangular 9V block',
  '             battery pack    a holder of AA cells   (NOT the same as a 9v battery)',
  '             coin cell       a 3V button cell',
  '  BOARDS     arduino, nano, esp32, breadboard',
  '  LIGHT      led             a single LED   (say "led", never "bulb" or "light")',
  '             rgb led         the three-colour one',
  '             lcd, oled       displays',
  '  SOUND      buzzer',
  '  MOVING     dc motor, servo, stepper, fan, propeller, wheel, caster, axle, gear,',
  '             pulley, belt, chassis, platform, beam, bracket, motor mount, gripper,',
  '             arm, hinge, lever, spring, crank, cam, linkage, conveyor',
  '  DRIVING    motor driver (an L298N), a4988, relay, transistor, mosfet',
  '  PASSIVE    resistor, diode, potentiometer',
  '  INPUT      button, switch, joystick, keypad, rfid',
  '  SENSING    ldr (light), temperature sensor, ultrasonic (distance), pir (motion)',
  '',
  'Say the count in words or digits — "two leds", "3 wheels". Do not repeat a name to mean',
  'more than one.'
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
  '- After adding parts, WIRE THEM. Parts sitting unconnected are not a build. Use "pin"',
  '  actions for the circuit you designed, or one "connect_all" when you want the planner.',
  '- Say WHY the circuit is shaped the way it is — which pin does what, what the resistor',
  '  is for. That reasoning is the thing worth reading.',
  '- The canvas below lists every wire that already exists, pin by pin. Read it before',
  '  wiring anything: if the connection is already there, say so instead of repeating it.',
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
    ? 'Parts on the canvas, with the pins each one really has:\n  ' +
      parts.map(p => (p.name || p.type) + ' (' + (p.type || '') + ')' +
        (Array.isArray(p.pins) && p.pins.length ? '  pins: ' + p.pins.join(' ') : '') +
        (Array.isArray(p.points) && p.points.length ? '  points: ' + p.points.join(' ') : ''))
        .join('\n  ')
    : 'The canvas is empty.');
  if (Array.isArray(c.joined) && c.joined.length)
    lines.push('Already bolted together: ' + c.joined.join('; '));
  if (Array.isArray(c.wired) && c.wired.length)
    lines.push('Wires already made, pin to pin:\n  ' + c.wired.join('\n  '));
  else if (c.wires) lines.push('Wires: ' + c.wires);
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
      /* Thinking tokens count against max_tokens. At 2000 a longer think left
         no room for the JSON, which came back truncated — a reply like ":ic". */
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
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

    /* A truncated answer is worse than none: half a JSON string parses as
       nothing, or worse, as a fragment. Say plainly that it was cut short. */
    if (!out || typeof out.reply !== 'string' || out.reply.trim().length < 4){
      console.error('unusable reply (stop_reason=' + r.stop_reason + '):',
                    JSON.stringify(text).slice(0, 400));
      const cut = r.stop_reason === 'max_tokens';
      return res.json({
        reply: cut ? 'That answer ran too long and got cut off — ask me again, more simply.'
                   : "I couldn't work that one out.",
        bullets: cut
          ? ['Shorter questions work better — "why is the LED off?" rather than a paragraph.']
          : ['Try naming a part directly — "add a motor" or "wire the LED to the Arduino".',
             'Or ask "what is missing?" and I will read the canvas myself.'],
        actions: []
      });
    }

    res.json({
      reply: String(out.reply || '').slice(0, 700),
      bullets: (out.bullets || []).slice(0, 4).map(b => String(b).slice(0, 200)),
      actions: (out.actions || []).slice(0, 24)
        .filter(a => a && a.op)
        .map(a => ({ op: String(a.op).toLowerCase().trim().slice(0, 24),
                     text: String(a.text || '').slice(0, 200) }))
    });
  } catch (err) {
    console.error(err);
    res.status(err && err.status === 429 ? 429 : 502).json({ error: plainError(err) });
  }
});

/* Render's free plan sleeps a service after 15 minutes idle, and waking it costs
   the learner a ~50 second wait on their next question. A quiet self-ping keeps
   it up. One always-on service fits inside the free monthly hours; set
   KEEP_AWAKE=off if you would rather let it sleep. */
const SELF = process.env.RENDER_EXTERNAL_URL || '';
if (SELF && process.env.KEEP_AWAKE !== 'off'){
  setInterval(() => {
    fetch(SELF + '/health').catch(() => {});
  }, 12 * 60 * 1000).unref?.();
  console.log('keep-awake ping every 12 min to ' + SELF);
}

app.listen(PORT, () => console.log('SparkBoard assistant listening on ' + PORT));
