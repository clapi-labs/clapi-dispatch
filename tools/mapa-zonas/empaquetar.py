import json, sys
raw, out = sys.argv[1], sys.argv[2]
def merged(*files):
    seen, out = set(), []
    for f in files:
        for e in json.load(open(f"{raw}/{f}"))["elements"]:
            if e["id"] in seen: continue
            seen.add(e["id"]); out.append(e)
    return out
roads = merged("roads.json", "roads_jamundi.json")
places = merged("places.json", "places_jamundi.json")
CLS = {"motorway":0,"trunk":0,"primary":1,"secondary":2,"tertiary":3,"residential":4,"unclassified":4,"living_street":4}
Q = 1e5
names, nidx, ways = [], {}, []
def simplify(pts, tol):
    if len(pts) < 3: return pts
    import math
    def d(p,a,b):
        (x,y),(x1,y1),(x2,y2)=p,a,b
        dx,dy=x2-x1,y2-y1
        if dx==dy==0: return math.hypot(x-x1,y-y1)
        t=max(0,min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)))
        return math.hypot(x-(x1+t*dx),y-(y1+t*dy))
    keep=[0,len(pts)-1]; stack=[(0,len(pts)-1)]
    while stack:
        i,j=stack.pop(); mx,k=0,-1
        for m in range(i+1,j):
            dd=d(pts[m],pts[i],pts[j])
            if dd>mx: mx,k=dd,m
        if mx>tol: keep.append(k); stack+= [(i,k),(k,j)]
    return [pts[i] for i in sorted(set(keep))]
for w in roads:
    t = w.get("tags", {}); c = CLS.get(t.get("highway"))
    if c is None or "geometry" not in w: continue
    pts = [(round(g["lat"]*Q), round(g["lon"]*Q)) for g in w["geometry"]]
    pts = simplify(pts, 2.5)
    name = t.get("name") or t.get("ref") or ""
    if name not in nidx: nidx[name]=len(names); names.append(name)
    flat=[pts[0][0],pts[0][1]]
    for a,b in zip(pts,pts[1:]): flat += [b[0]-a[0], b[1]-a[1]]
    ways.append([c, nidx[name], flat])
def label(p):
    n = p["tags"]["name"]
    # Al sur de 3.30 es Jamundí: sus barrios se marcan para no confundirlos
    # con los de Cali que se llaman igual (hay un San Fernando en cada uno).
    return n if p["lat"] >= 3.30 or n == "Jamundí" else f"{n} · Jamundí"
pl = [[label(p), round(p["lat"]*Q), round(p["lon"]*Q), p["tags"].get("place")] for p in places if p.get("tags",{}).get("name")]
json.dump({"q":Q,"names":names,"ways":ways,"places":pl}, open(out,"w"), separators=(",",":"), ensure_ascii=False)
print(len(ways), "vias,", len(names), "nombres,", len(pl), "barrios")
