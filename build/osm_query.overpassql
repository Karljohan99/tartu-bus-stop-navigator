[out:json][timeout:300];
(
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"](58.30,26.52,58.47,26.84);
relation["type"="route"]["route"="bus"]["network"="Tartu linn"](58.28,26.50,58.48,26.92);
way(r);
)->.a;
(.a; relation["type"="restriction"](bw.a);)->.b;
.b out body;
node(w.a);
out skel;
