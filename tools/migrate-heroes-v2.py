# One-off migration: heroes.json v0.1 (compact rows) -> v0.2 (named fields).
import json, sys
src = json.load(open('data/heroes.json', encoding='utf-8'))
KEYS = ['frontline','engage','cc','burst','damage','poke','mobility','peel','sustain','objective','dive','early','scaling']
LANE = {'E':'exp','J':'jungle','M':'mid','G':'gold','R':'roam'}
CLASS = {'tank':'Tank','fighter':'Fighter','assassin':'Assassin','mage':'Mage','marksman':'Marksman','support':'Support'}
FUNC = {'frontline':'frontline','engage':'engage','cc':'crowd control','burst':'burst','damage':'sustained damage','poke':'poke',
        'mobility':'mobility','peel':'peel','sustain':'sustain','objective':'objective pressure','dive':'backline access','scaling':'late-game scaling'}
prov = set(src.get('provisional', {}).get('ids', []))
heroes = []
for id_, name, lanes, cls, dmg, stats, tags, flags in src['heroes']:
    r = {k: int(stats[i]) for i, k in enumerate(KEYS)}
    ls = [LANE[c] for c in lanes]
    heroes.append({
        'id': id_, 'name': name,
        'class': [CLASS[cls]], 'damageType': 'physical' if dmg == 'p' else 'magic',
        'lanes': {'primary': ls[0], 'flex': {l: 0.8 for l in ls[1:]}},
        'functions': [FUNC[k] for k in KEYS if k in FUNC and r[k] >= 3],
        'archetypes': [t for t in tags.split(',') if t],
        'ratings': r,
        'flags': [f for f in flags.split(',') if f],
        'profile': 'provisional' if id_ in prov else 'baseline',
    })
out = {
  'version': '0.2.0',
  'schema': {
    'about': 'GAME DATA only: official/current hero identity. Competitive usage lives in data/meta/<dataset>-usage.json.',
    'lanes': 'primary lane plus flex lanes with a weight 0-1 (how natural the flex lane is; primary = 1)',
    'class': 'official hero class(es); a description, not a draft role',
    'functions': 'what the hero does in a composition',
    'archetypes': 'engage, pickoff, dive, poke, protect, frontToBack, scale',
    'ratings': '0-3 each. frontline, engage, cc, burst, damage (sustained), poke, mobility, peel, sustain, objective, dive (backline access), early, scaling',
    'forms': 'optional: distinct playable forms with rating overrides; the engine scores each form against the draft',
    'flags': 'antiDive, antiDash, antiPoke, antiHeal, antiCC, tankShred, lastPick',
    'profile': 'reviewed = confirmed by the user; baseline = first-pass estimate; provisional = estimate from incomplete source info'
  },
  'heroes': heroes,
  'aliases': src['aliases'],
  'counters': src['counters'],
}
def dump(o):
    # one hero per line for readable diffs
    hs = ',\n    '.join(json.dumps(h, ensure_ascii=False) for h in o['heroes'])
    rest = {k: v for k, v in o.items() if k != 'heroes'}
    s = json.dumps(rest, indent=2, ensure_ascii=False)
    return s[:-2] + ',\n  "heroes": [\n    ' + hs + '\n  ]\n}\n'
text = dump(out); json.loads(text)
open('data/heroes.json', 'w', encoding='utf-8').write(text)
print(len(heroes), 'heroes migrated')
