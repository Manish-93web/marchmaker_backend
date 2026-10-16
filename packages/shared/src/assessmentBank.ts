import type { AssessmentKey, QuestionDef } from './assessments';

export interface AssessmentBank {
  key: AssessmentKey;
  title: string;
  description: string;
  minutes: number;
  dimensions: string[];
  questions: QuestionDef[];
}

const lk = (id: string, prompt: string, dimension: string, reverse = false): QuestionDef => ({
  id,
  type: 'likert',
  prompt,
  dimension,
  ...(reverse && { reverse }),
});

const choice = (id: string, prompt: string, dimension: string, opts: [string, number][]): QuestionDef => ({
  id,
  type: 'single_choice',
  prompt,
  dimension,
  options: opts.map(([label, value], i) => ({ id: `${id}_${String.fromCharCode(97 + i)}`, label, value })),
});

const rank = (id: string, prompt: string, items: [string, string][]): QuestionDef => ({
  id,
  type: 'ranking',
  prompt,
  items: items.map(([label, dimension], i) => ({ id: `${id}_${i + 1}`, label, dimension })),
});

/** Seed question banks (version 1). Live copies are stored in the database and editable by admins. */
export const ASSESSMENT_BANKS: AssessmentBank[] = [
  {
    key: 'values',
    title: 'Values and priorities',
    description: 'What you put first when you think about the life you want.',
    minutes: 5,
    dimensions: ['ambition', 'tradition', 'security', 'giving'],
    questions: [
      lk('v1', 'I would rather build something ambitious than lead a calm, predictable life.', 'ambition'),
      lk('v2', 'Career growth is one of the most important things in my life.', 'ambition'),
      lk('v3', 'I would happily accept a lower salary for more time and peace.', 'ambition', true),
      lk('v4', 'Customs and rituals from my family are important to keep alive.', 'tradition'),
      lk('v5', 'I am comfortable letting go of old customs that do not suit my life.', 'tradition', true),
      lk('v6', 'I like to know that my finances and home are settled before taking any big step.', 'security'),
      lk('v7', 'I would be excited by a big move to a new city or country for a good opportunity.', 'security', true),
      lk('v8', 'Helping others, whether family or community, is a big part of what gives my life meaning.', 'giving'),
      choice('v9', 'Which sounds most like a good year for you?', 'ambition', [
        ['A quiet year with time for family and rest', 0],
        ['A balanced year with some growth and some downtime', 0.5],
        ['A demanding year in which I achieve something big', 1],
      ]),
      choice('v10', 'When your family disagrees with a choice you want to make, you usually...', 'tradition', [
        ['Go ahead, with respect, and explain later', 0],
        ['Try to find a middle path everyone can accept', 0.5],
        ['Give their view a lot of weight and adjust your plan', 1],
      ]),
      rank('v11', 'Rank these from most to least important in your life right now.', [
        ['A successful career', 'ambition'],
        ['Honouring family traditions', 'tradition'],
        ['Financial and personal stability', 'security'],
        ['Contributing to people around me', 'giving'],
      ]),
    ],
  },
  {
    key: 'communication',
    title: 'Communication and conflict',
    description: 'How you speak, listen and work through disagreements.',
    minutes: 5,
    dimensions: ['directness', 'conflict_pace', 'expressiveness'],
    questions: [
      lk('c1', 'I say what I think, even when it may be uncomfortable to hear.', 'directness'),
      lk('c2', 'I would rather soften a message than risk upsetting someone.', 'directness', true),
      lk('c3', 'I prefer people to be blunt with me rather than hint at what they mean.', 'directness'),
      lk('c4', 'After a disagreement, I want to talk it through right away.', 'conflict_pace'),
      lk('c5', 'I need time alone to calm down before I can discuss a problem.', 'conflict_pace', true),
      lk('c6', 'Silence after an argument makes me uneasy until it is sorted out.', 'conflict_pace'),
      lk('c7', 'I find it easy to tell the people close to me how I am feeling.', 'expressiveness'),
      lk('c8', 'I show that I care through actions more than through words.', 'expressiveness', true),
      choice('c9', 'Your partner forgets something that mattered to you. You would most likely...', 'directness', [
        ['Say nothing and hope they notice later', 0],
        ['Mention it gently when the moment feels right', 0.5],
        ['Tell them plainly how it made you feel, soon', 1],
      ]),
      choice('c10', 'After a tiring day, how do you prefer to unwind with your partner?', 'expressiveness', [
        ['Quietly, each doing our own thing', 0],
        ['A little conversation, then some quiet', 0.5],
        ['Talking through the day in detail', 1],
      ]),
    ],
  },
  {
    key: 'family',
    title: 'Family and roles',
    description: 'What family means to you and how you imagine life at home.',
    minutes: 5,
    dimensions: ['family_involvement', 'role_traditionalism', 'privacy_need'],
    questions: [
      lk('f1', 'My parents should have a say in major decisions of my married life.', 'family_involvement'),
      lk('f2', 'I would like us to live close to, or with, my family.', 'family_involvement'),
      lk('f3', 'Big decisions should be made by the couple alone.', 'family_involvement', true),
      lk('f4', 'Household responsibilities should be divided equally, whatever the circumstances.', 'role_traditionalism', true),
      lk('f5', 'It is natural for partners to take on different, familiar roles at home.', 'role_traditionalism'),
      lk('f6', 'I need regular time and space that is just mine.', 'privacy_need'),
      lk('f7', 'I love a busy home with relatives and guests often around.', 'privacy_need', true),
      choice('f8', 'Where would you most like to live after marriage?', 'family_involvement', [
        ['Our own place, away from both families', 0],
        ['Our own place, nearby family', 0.5],
        ['With family in a joint household', 1],
      ]),
      choice('f9', 'If both partners work, who takes the lead on managing the home?', 'role_traditionalism', [
        ['Whoever has more time; it keeps changing', 0],
        ['Shared evenly with clear agreements', 0.5],
        ['Roughly along familiar roles, with help from the other', 1],
      ]),
      rank('f10', 'Rank what you would most want from your family after marriage.', [
        ['Their guidance and involvement', 'family_involvement'],
        ['Space to run our own home', 'privacy_need'],
        ['Familiar ways of running the household', 'role_traditionalism'],
      ]),
    ],
  },
  {
    key: 'finances',
    title: 'Money and security',
    description: 'How you think about earning, saving and sharing money.',
    minutes: 4,
    dimensions: ['saving_orientation', 'financial_transparency', 'risk_appetite'],
    questions: [
      lk('m1', 'I feel uneasy if I do not have a solid amount saved.', 'saving_orientation'),
      lk('m2', 'Money is meant to be enjoyed, not hoarded.', 'saving_orientation', true),
      lk('m3', 'I track where my money goes every month.', 'saving_orientation'),
      lk('m4', 'Married partners should share full details of income, savings and debts.', 'financial_transparency'),
      lk('m5', 'Each partner should keep some money that is entirely their own.', 'financial_transparency', true),
      lk('m6', 'I would be comfortable investing in something with a chance of loss for a better return.', 'risk_appetite'),
      lk('m7', 'I prefer guaranteed small returns over uncertain larger ones.', 'risk_appetite', true),
      choice('m8', 'You receive an unexpected bonus. What do you do?', 'saving_orientation', [
        ['Spend it on something memorable', 0],
        ['Save half and enjoy half', 0.5],
        ['Save or invest nearly all of it', 1],
      ]),
      choice('m9', 'How would you like to manage household money as a couple?', 'financial_transparency', [
        ['Separate accounts, shared contribution to common costs', 0],
        ['Some shared, some separate', 0.5],
        ['Everything in common and decided together', 1],
      ]),
    ],
  },
  {
    key: 'lifestyle',
    title: 'Lifestyle and pace',
    description: 'How you like your days, evenings and weekends to feel.',
    minutes: 4,
    dimensions: ['social_energy', 'routine', 'activity'],
    questions: [
      lk('l1', 'I feel energised after a day spent around lots of people.', 'social_energy'),
      lk('l2', 'My ideal weekend is mostly quiet and at home.', 'social_energy', true),
      lk('l3', 'I like my days to follow a predictable routine.', 'routine'),
      lk('l4', 'I would rather decide what to do on the day than plan ahead.', 'routine', true),
      lk('l5', 'I like to keep moving: walks, workouts, outings, projects.', 'activity'),
      lk('l6', 'A perfect holiday is simply doing very little.', 'activity', true),
      choice('l7', 'Friends invite you out on a weeknight. You usually...', 'social_energy', [
        ['Politely stay home', 0],
        ['Go sometimes, depending on the week', 0.5],
        ['Join gladly; I love a spontaneous plan', 1],
      ]),
      choice('l8', 'Your ideal morning looks like...', 'routine', [
        ['Slow and unplanned', 0],
        ['A loose routine with some flexibility', 0.5],
        ['An organised start at the same time each day', 1],
      ]),
    ],
  },
  {
    key: 'faith',
    title: 'Faith and traditions',
    description: 'The place of faith, ritual and cultural practice in your life.',
    minutes: 3,
    dimensions: ['religiosity', 'ritual_importance', 'openness_to_difference'],
    questions: [
      lk('r1', 'Faith is central to how I make everyday decisions.', 'religiosity'),
      lk('r2', 'I would like my partner to share my faith or spiritual path.', 'religiosity'),
      lk('r3', 'Festivals and rituals are an important part of the year in my home.', 'ritual_importance'),
      lk('r4', 'I would keep daily or weekly religious practices in our home.', 'ritual_importance'),
      lk('r5', 'I am comfortable with a partner whose practice is quite different from mine.', 'openness_to_difference'),
      lk('r6', 'Differences in faith can be a strength in a marriage.', 'openness_to_difference'),
      choice('r7', 'How would you like children to be raised, in terms of faith?', 'religiosity', [
        ['Free to choose their own path', 0],
        ['Exposed to our traditions, with room to question', 0.5],
        ['Raised firmly within our faith', 1],
      ]),
      choice('r8', 'How would you like festivals to be marked in your home?', 'ritual_importance', [
        ['Simply, with a meal or a call to family', 0],
        ['With the main rituals, and celebrations with family', 0.5],
        ['With the full traditions and observances', 1],
      ]),
    ],
  },
];

export const BANK_BY_KEY = Object.fromEntries(ASSESSMENT_BANKS.map((b) => [b.key, b])) as Record<AssessmentKey, AssessmentBank>;
