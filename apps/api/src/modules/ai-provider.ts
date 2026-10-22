/**
 * AI providers (Wave 2: W2.2 AI agent, W2.3 agent assistance).
 *
 * Every AI feature talks to an `AiProvider`. Two exist:
 *  - `SimulatedAiProvider` (the default, and the only one used in tests): deterministic and clearly labelled. It
 *    answers only by quoting the company's own knowledge articles, summarises by extracting sentences, and marks its
 *    "translations" as simulated. It lets every rule around AI (what it may say, budgets, explanations, hand-over)
 *    be built and tested without an AI account.
 *  - `AnthropicProvider`: calls the Anthropic Messages API with the company's key from configuration. It is not used
 *    until an AI account exists and the owner approves it (owner-actions item 5). Nothing in it has been run against
 *    the live service.
 *
 * Whatever a provider returns, the caller checks it before anyone sees it (see ai.ts): the provider is never trusted
 * to follow its instructions.
 */
export interface AiRequest {
  task: 'agent_reply' | 'translate' | 'summarise' | 'suggest_replies';
  /** Fixed instructions; never contains customer text. */
  system: string;
  /** Material the model may rely on (knowledge articles, tool results), each with an id the answer must cite. */
  context: Array<{ id: string; kind: 'article' | 'tool'; title: string; text: string }>;
  /** The conversation, oldest first. Customer text is data, not instructions. */
  messages: Array<{ from: 'customer' | 'team' | 'automation'; text: string }>;
  /** For translation: the target language. */
  targetLanguage?: 'en' | 'ar';
  maxOutputTokens: number;
}
export interface AiResponse {
  text: string;
  /** For agent replies: the ids from `context` the answer relies on. */
  citations: string[];
  /** The provider's own judgement, when it gives one. */
  confidence: 'high' | 'low';
  inputTokens: number;
  outputTokens: number;
  model: string;
  simulated: boolean;
}
export interface AiProvider {
  readonly name: 'simulated' | 'anthropic';
  complete(req: AiRequest, signal?: AbortSignal): Promise<AiResponse>;
}

const words = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[ً-ْـ]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
const STOP = new Set(['the', 'and', 'you', 'your', 'for', 'are', 'can', 'what', 'how', 'is', 'do', 'does', 'a', 'to', 'of', 'in', 'on', 'i', 'my', 'me', 'we',
  'هل', 'ما', 'في', 'من', 'على', 'عن', 'أن', 'الى', 'إلى', 'كم', 'لو', 'او', 'أو']);
const tokens = (s: string) => Math.ceil(s.length / 4);

/** Deterministic stand-in for a language model. Everything it produces is labelled as simulated where people see it. */
export class SimulatedAiProvider implements AiProvider {
  readonly name = 'simulated' as const;

  async complete(req: AiRequest): Promise<AiResponse> {
    const input = [req.system, ...req.context.map((c) => c.text), ...req.messages.map((m) => m.text)].join('\n');
    const lastCustomer = [...req.messages].reverse().find((m) => m.from === 'customer')?.text ?? '';
    let text = ''; let citations: string[] = []; let confidence: 'high' | 'low' = 'low';
    if (req.task === 'agent_reply' || req.task === 'suggest_replies') {
      // Picks the knowledge passage sharing the most meaningful words with the customer's last message.
      const q = new Set(words(lastCustomer).filter((w) => !STOP.has(w)));
      let best: { id: string; score: number; text: string } | null = null;
      for (const c of req.context) {
        const score = words(`${c.title} ${c.text}`).filter((w) => q.has(w)).length;
        if (score > 0 && (!best || score > best.score)) best = { id: c.id, score, text: c.text };
      }
      if (best && best.score >= 2) {
        const first = best.text.split(/(?<=[.!?؟])\s+/).slice(0, 2).join(' ');
        text = first; citations = [best.id]; confidence = 'high';
      } else {
        text = ''; confidence = 'low';
      }
    } else if (req.task === 'summarise') {
      const customer = req.messages.filter((m) => m.from === 'customer').map((m) => m.text);
      const team = req.messages.filter((m) => m.from !== 'customer').map((m) => m.text);
      const lines = [];
      if (customer.length) lines.push(`Customer: ${customer[0]!.slice(0, 200)}${customer.length > 1 ? ` (+${customer.length - 1} more messages; latest: ${customer.at(-1)!.slice(0, 160)})` : ''}`);
      if (team.length) lines.push(`Team: ${team.at(-1)!.slice(0, 200)}`);
      text = lines.join('\n') || 'No messages yet.';
      confidence = 'low';
    } else if (req.task === 'translate') {
      // A simulation cannot translate: it returns the text unchanged, marked so nobody mistakes it for a translation.
      text = lastCustomer;
      confidence = 'low';
    }
    return { text, citations, confidence, inputTokens: tokens(input), outputTokens: tokens(text), model: 'simulated-1', simulated: true };
  }
}

/** Anthropic Messages API. Built for when an AI account is approved; not exercised against the live service yet. */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  constructor(private readonly apiKey: string, private readonly model: string, private readonly endpoint = 'https://api.anthropic.com/v1/messages') {}

  async complete(req: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const context = req.context.map((c) => `<source id="${c.id}" kind="${c.kind}">\n<title>${esc(c.title)}</title>\n${esc(c.text)}\n</source>`).join('\n');
    const convo = req.messages.map((m) => `<message from="${m.from}">${esc(m.text)}</message>`).join('\n');
    const task = req.task === 'translate' ? `Translate the last customer message into ${req.targetLanguage === 'ar' ? 'Arabic' : 'English'}. Reply with the translation only.`
      : req.task === 'summarise' ? 'Summarise this conversation for a colleague in at most four short lines. Mark anything uncertain.'
      : 'Reply with JSON: {"text": string, "citations": string[], "confidence": "high" | "low"}. Use only the sources; cite the ids you used; if the sources do not answer, return an empty text and confidence "low".';
    const res = await fetch(this.endpoint, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model, max_tokens: req.maxOutputTokens, system: req.system,
        messages: [{ role: 'user', content: `<sources>\n${context}\n</sources>\n<conversation>\n${convo}\n</conversation>\n${task}` }],
      }),
    });
    if (!res.ok) throw Object.assign(new Error('AI provider error'), { code: `ai_http_${res.status}` });
    const body = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
    const raw = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    let text = raw; let citations: string[] = []; let confidence: 'high' | 'low' = 'low';
    if (req.task === 'agent_reply' || req.task === 'suggest_replies') {
      try {
        const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { text?: unknown; citations?: unknown; confidence?: unknown };
        text = typeof j.text === 'string' ? j.text : '';
        citations = Array.isArray(j.citations) ? j.citations.filter((x): x is string => typeof x === 'string') : [];
        confidence = j.confidence === 'high' ? 'high' : 'low';
      } catch { text = ''; }
    }
    return { text, citations, confidence, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, model: body.model ?? this.model, simulated: false };
  }
}

const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
