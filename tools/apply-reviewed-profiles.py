# Applies user-reviewed hero profiles (2026-11-19) to data/heroes.json.
import json
path = 'data/heroes.json'
db = json.load(open(path, encoding='utf-8'))
K = ['frontline','engage','cc','burst','damage','poke','mobility','peel','sustain','objective','dive','early','scaling']
def R(*v): return dict(zip(K, v))
NOTE = 'Reviewed by user 2026-11-19; lanes reflect official/current identity, not observed MPL usage.'
REVIEWED = {
  'hirara': dict(cls=['Assassin'], lanes={'primary':'jungle','flex':{}},
    functions=['backline access','burst','finisher','chase','follow-up CC','cleanup'],
    archetypes=['dive','pickoff'],
    #          fl en cc bu dm po mo pe su ob dv ea sc
    ratings=R(0, 0, 1, 3, 2, 0, 3, 0, 0, 2, 3, 2, 2),
    note='Not an engage or frontline hero: CC is part of her combo/follow-up. mlbbdex lists no separate ultimate role.'),
  'marcel': dict(cls=['Support'], lanes={'primary':'roam','flex':{}},
    functions=['frontline presence','crowd control','disruption','peel','teamfight zone control'],
    archetypes=['engage','frontToBack','protect'],
    ratings=R(2, 2, 3, 1, 0, 0, 2, 3, 0, 2, 1, 2, 2),
    note='Support class, not Tank; his ultimate drives his Control / Frontline / Teamfight value.'),
  'kalea': dict(cls=['Support','Fighter'], lanes={'primary':'roam','flex':{}},
    functions=['engage','control','peel','sustain','protection'],
    archetypes=['engage','protect'],
    ratings=R(2, 2, 3, 1, 1, 0, 2, 2, 2, 1, 1, 2, 2),
    note='Both engage/control and peel/sustain; the engine picks whichever the composition needs.'),
  'lukas': dict(cls=['Fighter'], lanes={'primary':'exp','flex':{'jungle':0.6}},
    functions=['sustained damage','sustain','skirmish','flexible frontline'],
    archetypes=['frontToBack'],
    ratings=R(2, 1, 2, 2, 3, 0, 2, 0, 3, 2, 2, 2, 2),
    note='EXP primary; Jungle is a lower-weight flex option until S18 draft-slot data confirms usage.'),
  'zetian': dict(cls=['Mage'], lanes={'primary':'mid','flex':{}},
    functions=['AoE damage','poke','control','teamfight'],
    archetypes=['poke','frontToBack'],
    ratings=R(0, 1, 3, 2, 3, 2, 1, 2, 1, 1, 0, 2, 2),
    note=None),
  'sora': dict(cls=['Fighter','Assassin'], lanes={'primary':'exp','flex':{}},
    functions=['dive','engage','crowd control','flexible frontline'],
    archetypes=['dive','engage','pickoff'],
    ratings=R(2, 2, 2, 2, 1, 0, 3, 0, 0, 1, 2, 2, 2),
    forms=[
      {'id':'thunder','label':'Thunder form','functions':['damage','mobility','backline dive','finisher'],
       'ratings':{'frontline':1,'engage':1,'cc':1,'burst':3,'dive':3}},
      {'id':'torrent','label':'Torrent form','functions':['control','crowd control','engage','teamfight disruption'],
       'ratings':{'frontline':2,'engage':3,'cc':3,'burst':1,'dive':1}},
    ],
    note='Value depends on whether the comp needs a starter (Torrent) or a damage diver (Thunder).'),
}
for h in db['heroes']:
    p = REVIEWED.get(h['id'])
    if not p: continue
    h['class'] = p['cls']; h['lanes'] = p['lanes']; h['functions'] = p['functions']
    h['archetypes'] = p['archetypes']; h['ratings'] = p['ratings']; h['profile'] = 'reviewed'
    if 'forms' in p: h['forms'] = p['forms']
    h['notes'] = ' '.join(x for x in [p['note'], NOTE] if x)
assert sum(h['profile']=='reviewed' for h in db['heroes']) == 6
def dump(o):
    hs = ',\n    '.join(json.dumps(h, ensure_ascii=False) for h in o['heroes'])
    rest = {k: v for k, v in o.items() if k != 'heroes'}
    t = json.dumps(rest, indent=2, ensure_ascii=False)
    return t[:-2] + ',\n  "heroes": [\n    ' + hs + '\n  ]\n}\n'
text = dump(db); json.loads(text)  # validate before touching the file
open(path, 'w', encoding='utf-8').write(text)
print('applied', list(REVIEWED))
