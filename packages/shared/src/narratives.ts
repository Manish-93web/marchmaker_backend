import { bandFor, type AssessmentKey, type Band } from './assessments';

export interface NarrativeSection {
  dimension: string;
  heading: string;
  body: string;
}

export interface Narrative {
  title: string;
  summary: string;
  sections: NarrativeSection[];
  closing: string;
  /** Which engine produced this text; "template" unless the optional rewriter ran. */
  source: 'template' | 'rewritten';
}

interface DimensionText {
  heading: string;
  low: string;
  mid: string;
  high: string;
}

interface AssessmentText {
  title: string;
  summary: string;
  closing: string;
  dimensions: Record<string, DimensionText>;
}

/**
 * Default, rule-based copy keyed on assessment -> dimension -> band.
 * Rules for every string here: second person, warm, no numbers, no scores, no judgement,
 * and no suggestion that either end of a spectrum is better than the other.
 */
export const NARRATIVE_TEXT: Record<AssessmentKey, AssessmentText> = {
  values: {
    title: 'Your values and priorities',
    summary: 'These answers describe what you tend to put first when you think about the life you are building.',
    closing: 'None of this is right or wrong. It helps us look for someone whose priorities sit comfortably beside yours.',
    dimensions: {
      ambition: {
        heading: 'Drive and ambition',
        low: 'You value an unhurried life and tend to measure success by contentment rather than titles. You are likely to protect your time and your peace.',
        mid: 'You balance ambition with ease. You like to grow, but you do not want work to take over everything else.',
        high: 'You are driven and like to be working towards something. You tend to see career growth as an important part of a good life.',
      },
      tradition: {
        heading: 'Tradition and change',
        low: 'You lean towards doing things in your own way and are comfortable setting aside custom when it does not fit your life.',
        mid: 'You respect tradition where it holds meaning for you and are open to adapting it where it does not.',
        high: 'Customs and the way things have always been done matter to you. They give your life shape and a sense of belonging.',
      },
      security: {
        heading: 'Security and adventure',
        low: 'You are drawn to new experiences and are comfortable with a little uncertainty if it leads somewhere interesting.',
        mid: 'You like a stable base, with room for the occasional leap.',
        high: 'Stability matters a great deal to you. You feel your best when the foundations of life are settled and predictable.',
      },
      giving: {
        heading: 'Generosity and community',
        low: 'You tend to focus your energy on your own household and closest people.',
        mid: 'You like to give your time and care to others when you can, without losing sight of your own needs.',
        high: 'Giving to others, whether family, friends or community, is a real source of meaning for you.',
      },
    },
  },
  communication: {
    title: 'How you communicate',
    summary: 'This is a picture of how you tend to speak, listen and work through disagreement.',
    closing: 'Good partners are rarely identical communicators. What helps is understanding each other\'s style.',
    dimensions: {
      directness: {
        heading: 'Directness',
        low: 'You prefer to raise things gently and choose your words with care, so that nobody feels hurt.',
        mid: 'You can be straightforward when it matters and gentle when that serves better.',
        high: 'You say what you mean plainly. You would rather things were out in the open than left to be guessed.',
      },
      conflict_pace: {
        heading: 'Resolving disagreement',
        low: 'You like time to think before talking through a disagreement, and you tend to come back to it once you feel settled.',
        mid: 'You are happy to talk things through soon, but can also wait if the moment is not right.',
        high: 'You like to resolve a disagreement quickly. Unspoken tension tends to bother you more than a difficult conversation.',
      },
      expressiveness: {
        heading: 'Sharing feelings',
        low: 'You tend to keep your feelings close and show care through actions more than words.',
        mid: 'You share what you feel with the people you trust, at a comfortable pace.',
        high: 'You are open about how you feel and enjoy talking about it with the people close to you.',
      },
    },
  },
  family: {
    title: 'Family and roles',
    summary: 'These answers describe what family means to you and how you picture daily life at home.',
    closing: 'Families work in many shapes. What matters is finding someone whose picture is compatible with yours.',
    dimensions: {
      family_involvement: {
        heading: 'Closeness with family',
        low: 'You value your independence and prefer to make major decisions as a couple, keeping family at a respectful distance.',
        mid: 'You like family to be a real part of your life while keeping decisions between the two of you.',
        high: 'Family is at the centre of your life. You expect parents and relatives to be closely involved in the big decisions.',
      },
      role_traditionalism: {
        heading: 'Roles at home',
        low: 'You picture a home where responsibilities are shared freely, and who does what depends on the day rather than on custom.',
        mid: 'You like a sensible division of responsibilities that suits both partners, with flexibility on either side.',
        high: 'You are comfortable with clear, familiar roles at home and see them as a source of order and security.',
      },
      privacy_need: {
        heading: 'Space and togetherness',
        low: 'You are happiest in a full, busy household and enjoy having people around.',
        mid: 'You enjoy company but also need some quiet time and space of your own.',
        high: 'You need a good amount of private space and quiet to feel at ease in your own home.',
      },
    },
  },
  finances: {
    title: 'Money and security',
    summary: 'This is how you tend to think about earning, saving and sharing money with a partner.',
    closing: 'Couples do best when they talk about money early and openly. This gives you a place to begin.',
    dimensions: {
      saving_orientation: {
        heading: 'Saving and spending',
        low: 'You believe money is there to be enjoyed and are happy to spend on experiences and the people you love.',
        mid: 'You like to save steadily while still allowing yourself to enjoy what you earn.',
        high: 'You are a careful saver and feel calmer when there is a solid cushion put away for the future.',
      },
      financial_transparency: {
        heading: 'Openness about money',
        low: 'You value a measure of financial independence, even within a marriage.',
        mid: 'You like to share the big picture with your partner while keeping some personal freedom.',
        high: 'You expect to be completely open about money with your partner, with shared planning and decisions.',
      },
      risk_appetite: {
        heading: 'Taking financial risks',
        low: 'You prefer cautious, predictable choices with money and dislike surprises.',
        mid: 'You are willing to take a measured risk when you understand it well.',
        high: 'You are comfortable taking financial risks if the possible reward is worth it.',
      },
    },
  },
  lifestyle: {
    title: 'Lifestyle and pace',
    summary: 'These answers describe how you like your days and weekends to feel.',
    closing: 'Shared rhythms make daily life easier, but differences can balance each other nicely too.',
    dimensions: {
      social_energy: {
        heading: 'Social energy',
        low: 'You recharge at home and prefer a small circle to a crowded room.',
        mid: 'You enjoy a good gathering as much as a quiet evening in.',
        high: 'You are energised by people and like a full social calendar.',
      },
      routine: {
        heading: 'Routine and spontaneity',
        low: 'You like to keep plans loose and see where the day takes you.',
        mid: 'You like a loose structure with room to improvise.',
        high: 'You like a well-organised life with routines that you can rely on.',
      },
      activity: {
        heading: 'Activity level',
        low: 'You prefer a relaxed pace and value rest and unhurried time.',
        mid: 'You enjoy a mix of activity and downtime.',
        high: 'You like to stay active and feel best when your days are full of movement and things to do.',
      },
    },
  },
  faith: {
    title: 'Faith and traditions',
    summary: 'This is how faith, ritual and cultural practice sit in your life.',
    closing: 'People of very different practice build happy homes. What helps is being honest about what matters to you.',
    dimensions: {
      religiosity: {
        heading: 'Place of faith',
        low: 'Faith plays a quiet or personal role in your life, and you do not need a partner to share it.',
        mid: 'Faith is a meaningful part of your life without ruling your daily choices.',
        high: 'Faith is central to how you live, and you would like a partner who shares or deeply respects it.',
      },
      ritual_importance: {
        heading: 'Rituals and observances',
        low: 'You keep rituals to a minimum and focus on what feels meaningful to you.',
        mid: 'You enjoy observing important occasions and festivals with your family.',
        high: 'Regular rituals and observances give your days and year their rhythm, and you would like to keep them in your home.',
      },
      openness_to_difference: {
        heading: 'Openness to differences',
        low: 'You would be most comfortable with a partner whose background and practice closely match your own.',
        mid: 'You are open to some differences in practice as long as there is mutual respect.',
        high: 'You welcome differences in faith and background and see them as something a couple can grow from.',
      },
    },
  },
};

/** Builds the member-facing narrative from internal dimension scores. Contains no numbers. */
export function buildNarrative(key: AssessmentKey, scores: Record<string, number>): Narrative {
  const text = NARRATIVE_TEXT[key];
  const sections: NarrativeSection[] = [];
  for (const [dimension, copy] of Object.entries(text.dimensions)) {
    const score = scores[dimension];
    if (score === undefined) continue;
    const band: Band = bandFor(score);
    sections.push({ dimension, heading: copy.heading, body: copy[band] });
  }
  return { title: text.title, summary: text.summary, sections, closing: text.closing, source: 'template' };
}

/** Optional rewriter (LLM) interface. Receives template text only: never names, ids or raw answers. */
export interface NarrativeRewriter {
  rewrite(sectionBody: string, context: { assessmentTitle: string; heading: string }): Promise<string>;
}

const BANNED = /\b(score|scored|percent|percentage|rating|rated|better than|worse than|compatib\w+|you should|must)\b/i;

/** Output guardrails: a rewrite is accepted only if it stays short, number-free and non-judgemental. */
export function isSafeRewrite(original: string, candidate: string): boolean {
  const c = candidate.trim();
  if (!c || c.length > original.length * 1.6 || c.length < original.length * 0.4) return false;
  if (/\d/.test(c) || BANNED.test(c)) return false;
  if (/[<>{}[\]]/.test(c)) return false;
  return true;
}

export async function rewriteNarrative(n: Narrative, rewriter: NarrativeRewriter): Promise<Narrative> {
  const sections: NarrativeSection[] = [];
  let changed = false;
  for (const s of n.sections) {
    try {
      const out = await rewriter.rewrite(s.body, { assessmentTitle: n.title, heading: s.heading });
      if (isSafeRewrite(s.body, out)) {
        sections.push({ ...s, body: out.trim() });
        changed = true;
        continue;
      }
    } catch {
      /* fall through to the template text */
    }
    sections.push(s);
  }
  return { ...n, sections, source: changed ? 'rewritten' : 'template' };
}
