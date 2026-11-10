import {DEFAULT_TEAM, percent, nextMatch, scenario, cellKind, eligible} from './model.js';
import {collectPositions} from './browser-positions.js';
import {TACTICS, predictOpponentLineups, compareStrategies} from './tactics.js';

const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;return node;};
const fmt=n=>n==null?'—':typeof n==='number'?new Intl.NumberFormat('de-DE',{maximumFractionDigits:2}).format(n):String(n);
const time=value=>value?new Date(value).toLocaleString('de-DE',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Berlin'})+' Uhr':'nicht terminiert';
const clear=node=>node.replaceChildren();
const titles={overview:['Unser nächstes Spiel.','Gegner verstehen. Entscheidungen vorbereiten.','◉','Übersicht'],teams:['Die Liga im Überblick.','Offizielle Tabelle und alle Mannschaften.','≡','Teams & Tabelle'],players:['Unsere Spieler. Ihr Profil.','Einzelbilanz, Form und historische Auftrittsschätzungen.','♙','Spieler'],details:['Ein Spieler. Alle Details.','Kennzahlen, Einsätze und vergangene Einzelspiele.','↗','Spielerdetails'],matches:['Die relevanten Begegnungen.','Unsere Spiele und die Vergangenheit des nächsten Gegners.','▦','Relevante Spiele'],positions:['Gegner auf Position 1 bis 8.','Historische Einzelpositionen und wahrscheinliche Aufstellung des nächsten Gegners.','▤','Gegnerpositionen'],tactics:['Taktische Aufstellung.','Spieler gezielt auf die acht Einzelpositionen verteilen.','♟','Taktik-Assistent'],pairings:['Die passenden Paarungen.','Einzelszenarien vergleichen und die optimale Zuordnung finden.','⇄','Einzelpaarungen'],performances:['Besondere Leistungen.','Highscores, Checkouts und weitere Bestleistungen der Liga.','☆','Bestleistungen'],statistics:['Die Zahlen hinter dem Spiel.','Einzel, Doppel und Scorerwerte übersichtlich als Tabellen.','▥','Portalstatistiken']};
let data=null, focus=DEFAULT_TEAM, current='overview', selectedPlayer=null, lastPlan=null;
let positionProgress='', positionBusy=false, tacticBlock=0, tacticResults=null, tacticMode='balanced';
let ownSet=new Set(), oppSet=new Set();
const nav=$('#nav');
for(const [id,meta] of Object.entries(titles)){const a=el('a');a.href='#'+id;a.append(el('span','nav-icon',meta[2]),el('span','',meta[3]));nav.append(a);}
const team=id=>data.teams.find(t=>t.id===id);
const context=()=>{const own=team(focus), match=nextMatch(data,focus), opponent=match?team(match.home===focus?match.away:match.home):null;return {own,match,opponent};};
const related=m=>m.home===focus||m.away===focus;
const played=m=>m.status==='FINISH'&&!m.bye&&m.date&&Date.parse(m.date)<Date.parse(data.calculated_at);
function card(title,subtitle){const node=el('section','card');if(title)node.append(el('h2','',title));if(subtitle)node.append(el('p','muted',subtitle));return node;}
function action(text,fn,cls=''){const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}
function empty(text){return el('p','empty',text);}
function playerButton(p,tid){return action(p.name,()=>{selectedPlayer={id:p.id,tid};location.hash='details';if(current==='details')render();},'player-link');}
function metric(label,value,note){const node=el('div','metric');node.append(el('span','',label),el('strong','',value),el('small','',note));return node;}
function warning(text){return el('div','warning',text);}
function table(columns,records,{label='Datentabelle',highlight=()=>false,onRow=null}={}){
  if(!records.length)return empty('Für diese Auswahl liegen keine Daten vor.');
  const wrap=el('div','table-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',label);
  const t=el('table'),head=el('thead'),hr=el('tr'),body=el('tbody');head.append(hr);t.append(head,body);wrap.append(t);
  let rows=[...records],sortIndex=-1,descending=false;
  const draw=()=>{clear(body);for(const record of rows){const tr=el('tr',highlight(record)?'table-highlight':'');for(const col of columns){const td=el('td',col.num?'num':'');const value=col.view?col.view(record):col.value(record);td.append(value instanceof Node?value:document.createTextNode(fmt(value)));tr.append(td);}if(onRow){const td=el('td');td.append(action('Alle Felder',()=>onRow(record)));tr.append(td);}body.append(tr);}};
  columns.forEach((col,i)=>{const th=el('th');th.scope='col';th.append(action(col.label+' ↕',()=>{descending=sortIndex===i?!descending:false;sortIndex=i;rows.sort((a,b)=>{const x=col.value(a),y=col.value(b);if(x==null)return y==null?0:1;if(y==null)return -1;const c=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'de');return descending?-c:c;});[...hr.children].forEach(n=>n.removeAttribute('aria-sort'));th.setAttribute('aria-sort',descending?'descending':'ascending');draw();}));hr.append(th);});
  if(onRow){const th=el('th','','Details');th.scope='col';hr.append(th);}draw();return wrap;
}
function col(label,key,num=false,view=null){return {label,value:typeof key==='function'?key:r=>r[key],num,view};}
function fields(value){const out=[];const walk=(v,path)=>{if(v&&typeof v==='object'){for(const [k,item] of Object.entries(v))walk(item,[...path,k]);}else out.push({field:path.join(' / '),value:v==null?'unbekannt':typeof v==='boolean'?(v?'Ja':'Nein'):v});};walk(value,[]);return out;}
function detailDialog(title,record){const dialog=el('dialog'),heading=el('div','dialog-head');heading.append(el('h2','',title),action('Schließen ×',()=>dialog.close()));dialog.append(heading,table([col('Feld','field'),col('Wert','value')],fields(record)));dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();}
function showError(error){const box=el('div','error',error.message||String(error));$('#notice').replaceChildren(box);}
function updateStatus(){const age=(Date.now()-Date.parse(data.as_of))/86400000;$('#data-status').textContent=`Datenstand: ${time(data.as_of)} (Europe/Berlin) · ${data.event.name} · ${data.season} · ${data.sources.length} Quellen`;
  $('#notice').replaceChildren();if(age>2)$('#notice').append(warning('Gespeicherter Datenstand ist älter als 48 Stunden. „Neu laden“ liest die veröffentlichte Datei. Neue Portaldaten werden vom Projektbetreiber über den vorbereiteten GitHub-Workflow eingespielt.'));
  if(data.errors.length)$('#notice').append(warning(`${data.errors.length} Abruflücken im Datenstand. Details unter Datenqualität.`));}
function render(){if(!data)return;current=location.hash.slice(1)||'overview';if(!titles[current])current='overview';$('#page-title').textContent=titles[current][0];$('#page-description').textContent=titles[current][1];for(const a of nav.children){a.classList.toggle('active',a.hash==='#'+current);if(a.hash==='#'+current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}updateStatus();const root=$('#content');clear(root);views[current](root);}

function matchTable(records){return table([col('Anwurf',m=>Date.parse(m.date)||null,false,m=>time(m.date)),col('Heim','home_name'),col('Gast','away_name'),col('Status','status',false,m=>m.status==='FINISH'?'Beendet':m.status),col('Sätze',m=>m.sets_home==null?'—':`${m.sets_home}:${m.sets_away}`),col('Bericht','report_complete',false,m=>m.report_complete?'Vollständig':m.status==='FINISH'?'Fehlt / unvollständig':'Noch offen')],records,{label:'Begegnungen',highlight:related});}
function overview(root){const {own,match,opponent}=context();const past=data.matches.filter(m=>related(m)&&played(m)).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));const standing=data.standings.find(r=>r.participantId===focus);const metrics=el('div','metrics');metrics.append(metric('Tabellenplatz',standing?.placement??'—',`${data.teams.length} Mannschaften in der Liga`),metric('Gespielte Begegnungen',fmt(past.length),`${standing?.win??'—'} Siege · ${standing?.tie??'—'} Unentschieden`),metric('Teamkader',fmt(own.players.length),'Im aktuellen Portal-Datenstand'),metric('Satzbilanz',standing?`${standing.sets1}:${standing.sets2}`:'—','Offizieller Tabellenstand'));root.append(metrics);
  const grid=el('div','grid-two'),fixture=card();fixture.classList.add('match-card');fixture.append(el('p','eyebrow','ALS NÄCHSTES · UNSERE BEGEGNUNG'));
  if(match){const teams=el('div','fixture-teams');teams.append(el('strong','',own.name),el('span','','GEGEN'),el('strong','',opponent?.name??'unbekannt'));fixture.append(teams,el('div','fixture-meta',`${time(match.date)} · ${match.home===focus?'Heimspiel':'Auswärtsspiel'}\n${match.home_name} — ${match.away_name}`),action('Paarungen vorbereiten →',()=>location.hash='pairings'));}else fixture.append(el('h2','','Kein nächster Gegner bestimmbar.'),el('p','muted',data.schedule_complete?'Kein zukünftiges terminiertes Spiel im Datenstand.':'Der Spielplan enthält Abruflücken.'));
  const form=card('Die Form des Gegners',opponent?opponent.name:'Noch kein Gegner verfügbar');if(opponent){const history=data.matches.filter(m=>(m.home===opponent.id||m.away===opponent.id)&&played(m)).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));const wins=history.filter(m=>m.home===opponent.id?m.sets_home>m.sets_away:m.sets_away>m.sets_home).length;form.append(el('p','small',`${history.length} abgeschlossene Teamspiele · ${wins} Siege`));const strip=el('div','form-strip');for(const m of history.slice(-5)){const a=m.home===opponent.id?m.sets_home:m.sets_away,b=m.home===opponent.id?m.sets_away:m.sets_home,s=a>b?'S':a<b?'N':'U';const tag=el('span','form '+(a>b?'w':a<b?'l':'d'),s);tag.title=`${m.home_name} – ${m.away_name}: ${m.sets_home}:${m.sets_away}`;strip.append(tag);}form.append(strip,el('p','small','Letzte bis zu fünf Teamspiele. Spielplanstärke ist nicht bereinigt.'));const likely=[...opponent.players].filter(p=>p.active&&p.attendance.p!=null).sort((a,b)=>b.attendance.p-a.attendance.p).slice(0,4);form.append(table([col('Häufige Einsätze','name'),col('Auftritt',p=>p.attendance.p,true,p=>percent(p.attendance.p)),col('Basis',p=>`${p.attendance.k}/${p.attendance.n}`)],likely));}grid.append(fixture,form);root.append(grid);
  const recent=card('Zuletzt auf dem Board','Die letzten Begegnungen unseres Teams.');recent.append(matchTable(past.slice(-5).reverse()));root.append(recent);const note=el('div','notice','Auftritt ist eine historische Schätzung, keine Zusage. Die Paarungsoptimierung ist ein bedingtes Einzelszenario bei verdeckter Aufstellung.');root.append(note);
}
function standings(root){const section=card('Offizielle Ligatabelle',`${data.teams.length} Teams · Fokus: ${team(focus).name}`);section.append(table([col('Platz','placement'),col('Mannschaft','participantName'),col('Spiele','matchCount',true),col('Siege','win',true),col('Unentschieden','tie',true),col('Niederlagen','lost',true),col('Punkte',r=>`${r.points1}:${r.points2}`),col('Sätze',r=>`${r.sets1}:${r.sets2}`),col('Legs',r=>`${r.legs1}:${r.legs2}`)],data.standings,{label:'Ligatabelle',highlight:r=>r.participantId===focus}));root.append(section);}
function playerRecords(){const {own,opponent}=context();return [own,...(opponent?[opponent]:[])].flatMap(t=>t.players.map(p=>({...p,team:t.name,tid:t.id})));}
function playerColumns(){return [col('Spieler','name',false,p=>playerButton(p,p.tid)),col('Team','team'),col('Einzel','games',true),col('Siege','wins',true),col('Legs',p=>`${p.legs}:${p.lost_legs}`),col('3-Dart-Ø','average',true),col('Auftritt',p=>p.attendance.p,true,p=>percent(p.attendance.p)),col('Basis',p=>`${p.attendance.k}/${p.attendance.n}`),col('95%-Intervall',p=>p.attendance.low,false,p=>`${percent(p.attendance.low)} – ${percent(p.attendance.high)}`)];}
function players(root){const section=card('Spieler & Auftrittsschätzung','Fokus-Team und nächster Gegner. Ein Spielername öffnet die Detailansicht.');const toolbar=el('div','toolbar'),search=el('input');search.type='search';search.placeholder='Spieler oder Team suchen …';search.setAttribute('aria-label','Spieler oder Team suchen');toolbar.append(search);const area=el('div');const draw=()=>{const query=search.value.toLocaleLowerCase('de');area.replaceChildren(table(playerColumns(),playerRecords().filter(p=>(p.name+' '+p.team).toLocaleLowerCase('de').includes(query)),{label:'Spielerübersicht',highlight:p=>p.tid===focus}));};search.addEventListener('input',draw);section.append(toolbar,area);root.append(section);draw();}
function details(root){const records=playerRecords();let choice=selectedPlayer&&data.teams.find(t=>t.id===selectedPlayer.tid)?.players.find(p=>p.id===selectedPlayer.id);if(!choice){root.append(empty('Wähle unter „Spieler“ einen Spieler aus.'),action('Zur Spielerauswahl →',()=>location.hash='players'));return;}const p=choice,att=p.attendance;const heading=card(p.name,team(selectedPlayer.tid).name);heading.append(el('p','small',`Mitglieds-ID ${p.id} · Gemeldet ${p.registered_from??'unbekannt'} bis ${p.registered_to??'unbekannt'}`));root.append(heading);const metrics=el('div','metrics');metrics.append(metric('Einzel',fmt(p.games),`${p.wins} Siege · ${p.games-p.wins} Niederlagen`),metric('3-Dart-Average',fmt(p.average),'Gewichtet aus erfassten Scores und Darts'),metric('Auftrittsschätzung',percent(att.p),`${att.k}/${att.n} geeignete Teamspiele`),metric('Legbilanz',`${p.legs}:${p.lost_legs}`,'Nur ausgewertete Einzel'));root.append(metrics);const facts=card('Berechnungsgrundlagen');facts.append(table([col('Merkmal','field'),col('Wert','value')],[{field:'95%-Wilson-Intervall',value:`${percent(att.low)} – ${percent(att.high)}`},{field:'Quote der letzten höchstens fünf Einsätze',value:percent(att.recent)},{field:'Geglättete Einzel-Siegquote (Modell)',value:percent(p.strength)},{field:'Erfasster Score / Darts',value:`${p.score} / ${p.darts}`},{field:'Beobachtungen (älteste zuerst)',value:p.observations.map(v=>v?'Einsatz':'kein Einsatz').join(' · ')||'keine'}]));const history=card('Ausgewertete Einzelspiele');history.append(table([col('Datum',g=>Date.parse(g.date),false,g=>time(g.date)),col('Gegner','opponent'),col('Legs','legs'),col('Ergebnis','won',false,g=>g.won?'Sieg':'Niederlage'),col('Teamspiel-ID','match_id')],[...p.history].reverse(),{label:'Einzelhistorie'}));root.append(facts,history);}
function relevantMatches(root){const {opponent}=context();const records=data.matches.filter(m=>related(m)||(opponent&&(m.home===opponent.id||m.away===opponent.id)&&played(m))).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));const section=card('Spielplan & Gegnerhistorie','Zukünftige Fremdbegegnungen werden ausgeblendet. Alle Zeiten Europe/Berlin.');section.append(matchTable(records));root.append(section);}

function candidates(t,match){if(!t)return [];const when=match?.date??data.calculated_at;return [...t.players].filter(p=>eligible(p,when)).sort((a,b)=>(b.attendance.p??-1)-(a.attendance.p??-1)||(b.strength??-1)-(a.strength??-1));}
function pairings(root){const {own,opponent,match}=context();if(!opponent){root.append(warning('Ohne verlässlich bekannten nächsten Gegner können keine Paarungen berechnet werden. Prüfe den Datenstand und Spielplan.'));return;}const ours=candidates(own,match),theirs=candidates(opponent,match);const selection=card('Das Kaderszenario','Wähle die eigenen Spieler auf der Y-Achse und den angenommenen Gegnerkader auf der X-Achse.');const toolbar=el('div','toolbar');const output=el('div');const counts=el('span','small');
  const grid=el('div','selection-grid');const drawChoices=()=>{clear(grid);for(const [label,list,set] of [[`Y · ${own.name}`,ours,ownSet],[`X · ${opponent.name}`,theirs,oppSet]]){const side=el('div');side.append(el('h3','',label));const box=el('div','selection-list');for(const p of list){const line=el('label','choice'),cb=el('input');cb.type='checkbox';cb.value=String(p.id);cb.checked=set.has(p.id);cb.disabled=p.strength==null;cb.setAttribute('aria-label',`${label}: ${p.name}`);const name=el('span','choice-name',p.name);name.append(el('small','',`${p.games} Einzel · ${percent(p.attendance.p)} Auftritt · Basis ${p.attendance.k}/${p.attendance.n}`));line.append(cb,name);if(p.strength==null)line.append(el('span','badge','Keine Einzelbasis'));box.append(line);cb.addEventListener('change',()=>{cb.checked?set.add(p.id):set.delete(p.id);invalidate();});}side.append(box);grid.append(side);}counts.textContent=`${ownSet.size} eigene Spieler · ${oppSet.size} Gegner gewählt`;};
  function invalidate(){lastPlan=null;output.replaceChildren(empty('Auswahl geändert. Bitte neu berechnen.'));counts.textContent=`${ownSet.size} eigene Spieler · ${oppSet.size} Gegner gewählt`;}
  toolbar.append(action('Häufigste 8 auswählen',()=>{ownSet=new Set(ours.filter(p=>p.strength!=null).slice(0,8).map(p=>p.id));oppSet=new Set(theirs.filter(p=>p.strength!=null).slice(0,8).map(p=>p.id));invalidate();drawChoices();}),action('Auswahl leeren',()=>{ownSet.clear();oppSet.clear();invalidate();drawChoices();}),counts);selection.append(toolbar,grid);const buttons=el('div','toolbar');buttons.style.marginTop='18px';const calculate=action('Paarungen berechnen →',()=>{try{const a=ours.filter(p=>ownSet.has(p.id)),b=theirs.filter(p=>oppSet.has(p.id)),plan=scenario(a,b);lastPlan={...plan,own:a.map(p=>({id:p.id,name:p.name})),opponents:b.map(p=>({id:p.id,name:p.name})),focus,as_of:data.as_of};drawMatrix(output,lastPlan);}catch(e){lastPlan=null;output.replaceChildren(el('div','error',e.message));}},'primary');buttons.append(calculate);selection.append(buttons,el('p','small','Mindestens ein eigener Spieler, mindestens ebenso viele Gegner, maximal 16 Gegner. Ohne Einzelbasis keine erfundene Siegchance.'));root.append(selection,output);drawChoices();if(lastPlan?.focus===focus)drawMatrix(output,lastPlan);else output.append(empty('Wähle einen Kader und berechne die Paarungen.'));}
function drawMatrix(root,plan){clear(root);const box=card('Alle direkten Vergleiche');box.append(el('p','pair-summary',`${fmt(plan.expected)} erwartete Einzelsiege von ${plan.own.length}`),el('p','small','Bedingtes Szenario: alle gewählten Spieler treten an. Die Werte sind unkalibrierte Modellschätzungen; keine garantierte Liga-Aufstellung.'));const legend=el('div','legend');for(const [cls,text]of[['win','Goldgelb: Y-Spieler favorisiert'],['loss','Rot umrandet: X-Spieler favorisiert'],['even','Gold umrandet: 50 / 50']]){const item=el('span');item.append(el('i','swatch '+cls),document.createTextNode(text));legend.append(item);}legend.append(el('span','','★ / dunkler Rahmen: optimale Paarung'));box.append(legend,el('p','small','Zellenwert = Siegchance des Y-Spielers. Horizontal und vertikal scrollen, mit Umschalt + Mausrad auch seitwärts.'));
  const scroll=el('div','matrix-wrap');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Siegchancenmatrix, eigene Spieler in Zeilen und Gegner in Spalten');scroll.addEventListener('wheel',e=>{if(e.shiftKey&&e.deltaY&&!e.deltaX){scroll.scrollLeft+=e.deltaY;e.preventDefault();}},{passive:false});const matrix=el('table','matrix'),head=el('thead'),hr=el('tr'),corner=el('th','','Y: eigene Spieler ↓ / X: Gegner →');corner.scope='col';hr.append(corner);for(const p of plan.opponents){const th=el('th','',p.name);th.scope='col';hr.append(th);}head.append(hr);const body=el('tbody');plan.own.forEach((p,i)=>{const tr=el('tr'),th=el('th','',p.name);th.scope='row';tr.append(th);plan.matrix[i].forEach((chance,j)=>{const kind=cellKind(chance),chosen=plan.assignment[i]===j,td=el('td',kind+(chosen?' chosen':''));td.append(el('strong','',percent(chance)+(chosen?' ★':'')),el('small','',kind==='win'?'Y favorisiert':kind==='loss'?'X favorisiert':'ausgeglichen'));td.title=`${p.name} gegen ${plan.opponents[j].name}: ${percent(chance)} für ${p.name}${chosen?' · optimale Paarung':''}`;tr.append(td);});body.append(tr);});matrix.append(head,body);scroll.append(matrix);box.append(scroll);root.append(box);const pairs=card('Empfohlene Einzelpaarungen');pairs.append(table([col('Eigener Spieler','own'),col('Gegner','opponent'),col('Siegchance Y','p',true,r=>percent(r.p))],plan.own.map((p,i)=>({own:p.name,opponent:plan.opponents[plan.assignment[i]].name,p:plan.matrix[i][plan.assignment[i]]})),{label:'Optimale Paarungen'}));root.append(pairs);}

// Positionen werden bereits in Python aus historischen Spielberichten berechnet.
// Die Webseite zeigt ausschließlich die exportierten Modellwerte, ohne sie neu zu schätzen.
function positions(root){
  const {opponent, match}=context();
  if(!opponent||!match){root.append(warning('Für diese Mannschaft ist kein kommendes Spiel mit bekanntem Gegner verfügbar.'));return;}
  const report=data.position_analyses?.[String(opponent.id)];
  const refreshCard=card('Positionen direkt im Browser berechnen','Lädt die abgeschlossenen Spielberichte dieses Gegners über die öffentliche 3K-Darts-API und erstellt die Prognose lokal. Kein Python und kein eigener Server erforderlich.');
  const refreshButton=action(positionBusy?'Lade Spielberichte …':'Spielberichte laden & analysieren',async()=>{
    if(positionBusy)return;
    positionBusy=true;positionProgress='Verbindung zu 3K-Darts wird aufgebaut …';render();
    try{
      const {result,downloaded,attempted}=await collectPositions(data,opponent.id,(done,total)=>{positionProgress=`${done} von ${total} Spielberichten geprüft …`;const progress=$('#positions-progress');if(progress)progress.textContent=positionProgress;});
      data.position_analyses??={};data.position_analyses[String(opponent.id)]=result;tacticResults=null;
      positionProgress=`${downloaded} von ${attempted} Berichten geladen, ${result.matches_used} ausgewertet. Nur in dieser Browsersitzung verfügbar.`;
      render();
    }catch(error){positionProgress=error.message||String(error);render();}
    finally{positionBusy=false;render();}
  },'primary');
  refreshButton.disabled=positionBusy;
  refreshCard.append(refreshButton);
  const progress=el('p','small',positionProgress||'Die Berechnung läuft lokal. Ob die externe API erreichbar ist, hängt von ihrer CORS-Konfiguration ab.');
  progress.id='positions-progress';progress.setAttribute('role','status');progress.setAttribute('aria-live','polite');refreshCard.append(progress);
  root.append(refreshCard);
  if(!report){root.append(warning('Noch keine Positionsanalyse vorhanden. Starte den Abruf mit dem Button oben. Die bereits veröffentlichte JSON-Datei enthält keine historischen Einzelpositionen.'));return;}
  const count=report.matches_used??0;
  const metrics=el('div','metrics');metrics.append(
    metric('Nächster Gegner',opponent.name,match.home===focus?'Heimspiel':'Auswärtsspiel'),
    metric('Historische Spiele',fmt(count),'Für Positionsmuster auswertbare Teamberichte'),
    metric('Einzelpositionen','1–8','Je acht Einzel pro Block'),
    metric('Datenstand',data.as_of?.slice(0,10)??'—','Vergangene Begegnungen vor Berechnungsstichtag'));
  root.append(metrics);
  const intro=card('Wahrscheinliche Gegner je Position',`Gegner: ${opponent.name} · Nächstes Spiel: ${time(match.date)}`);
  intro.append(el('p','small','Je Position zeigen wir die historisch wahrscheinlichsten Spieler. Die Werte sind normierte, heuristische Anteile und keine bestätigten Aufstellungen. Positionen werden aus zwei Einzelblöcken pro Spiel abgeleitet.'));
  if(!count)intro.append(warning('Keine vollständig auswertbaren historischen Spielberichte: Positionen sind nicht zuverlässig schätzbar.'));
  // Position favorites: responsive cards instead of a wide data table.
  const slotGrid=el('div','slot-grid');
  for(const slot of report.slot_favorites||[]){
    const tile=el('article','slot-card');
    tile.append(el('span','slot-number',`POSITION ${slot.position}`));
    const candidates=el('div','slot-candidates');
    for(const [index,candidate] of (slot.candidates||[]).slice(0,3).entries()){
      const row=el('div','slot-candidate');
      row.append(el('span','slot-rank',String(index+1)),el('span','slot-name',candidate.name),el('strong','slot-percent',percent(candidate.probability)));
      candidates.append(row);
    }
    if(!candidates.childElementCount)candidates.append(el('span','muted','Keine verwertbaren Positionsdaten'));
    tile.append(candidates);slotGrid.append(tile);
  }
  intro.append(slotGrid);root.append(intro);

  const section=card('Positionsmatrix aller Gegenspieler','Pro Spieler: geglätteter, nach Aktualität gewichteter Anteil je Position und tatsächliche Anzahl historischer Einsätze in Klammern.');
  section.classList.add('position-section');
  const search=el('input');search.type='search';search.placeholder='Spieler suchen …';search.setAttribute('aria-label','Gegenspieler nach Namen filtern');
  const toolbar=el('div','toolbar');toolbar.append(search);section.append(toolbar);
  const legend=el('p','position-legend','Beispiel: 15,5 % (2) = geschätzter Anteil 15,5 % und 2 beobachtete Einsätze auf dieser Position. Die Prozente sind geglättet und müssen nicht dem Anteil der absoluten Einsätze entsprechen.');
  section.append(legend);
  const body=el('div','position-player-list');section.append(body);root.append(section);
  const draw=()=>{
    const players=(report.players||[]).filter(p=>p.name.toLocaleLowerCase('de').includes(search.value.toLocaleLowerCase('de')));
    clear(body);
    if(!players.length){body.append(empty('Keine passenden Spieler gefunden.'));return;}
    for(const p of players){
      const item=el('article','position-player');
      const heading=el('div','position-player-heading'),identity=el('div','position-player-identity');
      identity.append(el('h3','',p.name));
      const details=el('p','position-player-meta',`${p.active?'Aktiver Kader':'Nicht aktiv'} · ${fmt(p.single_appearances??0)} Einzeleinsätze · Auftritt ${percent(p.attendance?.p)}`);
      identity.append(details);heading.append(identity);
      if(p.most_likely_position!=null)heading.append(el('span','position-favorite',`Favorit: Pos. ${p.most_likely_position}`));
      item.append(heading);
      const matrix=el('div','position-matrix');matrix.setAttribute('role','group');matrix.setAttribute('aria-label',`Positionsverteilung für ${p.name}`);
      for(let i=0;i<8;i++){
        const value=p.position_probabilities?.[i];
        const raw=p.observed_positions?.[i]??0;
        const cell=el('div','position-cell'+(p.most_likely_position===i+1&&value!=null?' is-favorite':''));
        if(value==null)cell.classList.add('is-unknown');
        else if(value>=.20)cell.classList.add('is-strong');
        cell.append(el('span','position-cell-label',`POS ${i+1}`));
        const result=el('strong','position-cell-value');
        result.append(document.createTextNode(value==null?'—':percent(value)+' '));
        result.append(el('span','position-cell-count',`(${fmt(raw)})`));
        cell.append(result);
        cell.setAttribute('aria-label',`Position ${i+1}: ${value==null?'keine Schätzung':percent(value)}, ${raw} beobachtete Einsätze`);
        matrix.append(cell);
      }
      item.append(matrix);
      const detail=action('Positionshistorie ansehen',()=>detailDialog(`Positionshistorie: ${p.name}`,{spieler:p.name,positionen:p.observed_positions,einzelblock_1:p.blocks?.[0],einzelblock_2:p.blocks?.[1],vergangene_positionen:p.history}),'position-detail');
      item.append(detail);body.append(item);
    }
  };
  search.addEventListener('input',draw);draw();
  const quality=card('Einordnung & Datenqualität');quality.append(el('p','small','P(Position | Einzeleinsatz) ist die nach Aktualität gewichtete, geglättete Positionsverteilung eines Spielers. Der Anteil je Position basiert zusätzlich auf der historischen Auftrittsschätzung. Beide Werte sind voneinander zu unterscheiden. Spieler ohne Positionshistorie werden nicht als Positionsfavoriten bewertet.'));
  const gaps=report.gaps||[];quality.append(el('p','small',`${gaps.length} Hinweise zur Datengrundlage. Bei fehlender eindeutiger Positionsnummer gilt die Reihenfolge der Portal-API als Annahme.`));
  if(gaps.length)quality.append(action('Hinweise zur Datenqualität anzeigen',()=>detailDialog('Hinweise zur Positionsanalyse',Object.fromEntries(gaps.map((g,i)=>[`Hinweis ${i+1}`,g])))));
  quality.append(action('Einzelpaarungen berechnen →',()=>location.hash='pairings','primary'));root.append(quality);
}

function performances(root){const section=card('Bestleistungen der Liga');const bar=el('div','toolbar'),select=el('select');select.setAttribute('aria-label','Bestleistungskategorie');for(const title of ['Alle Kategorien',...new Set(data.performances.map(p=>p.category))]){const op=el('option','',title);op.value=title;select.append(op);}const search=el('input');search.type='search';search.placeholder='Spieler suchen …';search.setAttribute('aria-label','Bestleistungen nach Spieler durchsuchen');bar.append(select,search);const area=el('div');const draw=()=>area.replaceChildren(table([col('Kategorie','category'),col('Spieler','name'),col('Wert','value',true),col('Anzahl','count',true)],data.performances.filter(p=>(select.value==='Alle Kategorien'||p.category===select.value)&&p.name.toLowerCase().includes(search.value.toLowerCase())),{label:'Bestleistungen'}));select.addEventListener('change',draw);search.addEventListener('input',draw);section.append(bar,area);root.append(section);draw();}
function statistics(root){const section=card('Portalstatistiken','Alle Teams der Liga. Die Tabellen können durchsucht und sortiert werden.');const toolbar=el('div','toolbar'),select=el('select');select.setAttribute('aria-label','Statistikart');for(const [key,name]of[['singleResult','Einzel'],['doubleResult','Doppel'],['totalResult','Gesamt'],['scorer','Scorerstatistiken']]){const op=el('option','',name);op.value=key;select.append(op);}const search=el('input');search.type='search';search.placeholder='Spieler oder Team suchen …';search.setAttribute('aria-label','Portalstatistiken durchsuchen');toolbar.append(select,search);const area=el('div');const draw=()=>{const query=search.value.toLowerCase();if(select.value==='scorer'){const rows=data.statistics.filter(p=>((p.name??'')+' '+p.team_name).toLowerCase().includes(query));area.replaceChildren(table([col('Spieler / Doppel','name'),col('Team','team_name'),col('3-Dart-Ø',p=>p.dartsTotal?3*p.scoreTotal/p.dartsTotal:null,true),col('Darts','dartsTotal',true),col('Score','scoreTotal',true),col('Spiele','matchesTotal',true),col('Siege','matchesWon',true),col('Legs','legCount',true),col('Gegner-Legs','legCountOpponent',true),col('Höchstes Checkout','checkoutMax',true),col('180er','count180',true),col('140er','count140',true),col('100er','count100',true)],rows,{label:'Scorerstatistiken',onRow:r=>detailDialog(r.name,r)}));}else{const rows=data.results.filter(p=>(p.displayName+' '+p.team_name).toLowerCase().includes(query)).map(p=>({...p,...p[select.value]}));area.replaceChildren(table([col('Platz','place',true),col('Spieler','displayName'),col('Team','team_name'),col('Spiele','matchCount',true),col('Siege','matchWon',true),col('Niederlagen','matchLost',true),col('Legs gewonnen','legs1',true),col('Legs verloren','legs2',true),col('Spieldifferenz','matchDiff',true),col('Legdifferenz','legsDiff',true)],rows,{label:'Spielerergebnisse',onRow:r=>detailDialog(r.displayName,r)}));}};select.addEventListener('change',draw);search.addEventListener('input',draw);section.append(toolbar,area);root.append(section);draw();}
function quality(root){const metrics=el('div','metrics');metrics.append(metric('Datenquellen',fmt(data.sources.length),'GET-Abrufe mit Zeitpunkt und SHA-256'),metric('Abruffehler',fmt(data.errors.length),'Unvollständige Daten werden gekennzeichnet'),metric('Spielberichte',fmt(data.matches.filter(m=>m.report_complete).length),'Vollständig ausgewertete Teamspiele'),metric('Spielplan',data.schedule_complete?'Vollständig':'Mit Lücken','Alle von der Phase gelieferten Runden'));root.append(metrics);const gaps=[...data.errors,...data.teams.flatMap(t=>t.gaps.map(g=>t.name+': '+g)),...Object.values(data.position_analyses||{}).flatMap(r=>(r.gaps||[]).map(g=>`Positionen Team ${r.team_id}: ${g}`))];const checks=card('Datenqualität');checks.append(el('p',gaps.length?'warning':'notice',gaps.length?gaps.join('\n'):'Keine Abruf- oder Namenszuordnungslücken im gespeicherten Datenstand.'),el('p','small',`Berechnungsstichtag: ${time(data.calculated_at)}. Keine automatisch bestätigten Aufstellungen. Detailberechnungen verwenden nur vor diesem Stichtag abgeschlossene Begegnungen.`));root.append(checks);const source=card('Quellenverzeichnis');source.append(table([col('Quelle','url',false,r=>{const a=el('a','',r.url);a.href=r.url;a.target='_blank';a.rel='noopener';return a;}),col('Abgerufen',r=>Date.parse(r.fetched_at),false,r=>time(r.fetched_at)),col('SHA-256','sha256')],data.sources,{label:'Datenquellen'}));root.append(source);}
function method(root){const section=card('Transparente Methodik');section.classList.add('method');section.innerHTML=`<h2>Was die Zahlen bedeuten.</h2><h3>Auftritt ist ein Einsatz, keine Zusage</h3><p>Mindestens ein gespieltes Einzel oder Doppel zählt als Auftritt. Geeignet sind nur vollständige, abgeschlossene Teamberichte im registrierten Kaderzeitraum. Je Teamspiel wird ein Spieler höchstens einmal gezählt. Fehlende Berichte gelten niemals als Abwesenheit. Ohne Beobachtung bleibt die Schätzung unbekannt.</p><p><code>p(Auftritt) = (Auftritte + 1) / (geeignete Teamspiele + 2)</code></p><p>Die Beta(1,1)-Glättung stabilisiert kleine Stichproben. Das angegebene 95%-Wilson-Intervall beschreibt die Unsicherheit der historischen Häufigkeit; es ist keine Garantie für das nächste Spiel. Urlaub, Krankheit und persönliche Zusagen sind unbekannt. Einzelwahrscheinlichkeiten bilden keinen gemeinsamen vollständigen Gegnerkader.</p><h3>Einzelstärke und Siegchance</h3><p><code>s = (Einzelsiege + 2) / (Einzelspiele + 4)</code><br><code>Odds = s / (1 − s)</code><br><code>P(A gewinnt gegen B) = Odds(A) / (Odds(A) + Odds(B))</code></p><p>Das ist ein unkalibriertes Bradley-Terry-Szenario aus geglätteten Einzel-Siegquoten, kein angepasstes Bradley-Terry-Fit. Unterschiedliche Gegnerstärken, Heimvorteil und zeitliche Form sind nicht bereinigt. Ohne Einzelbasis einer Seite gibt es keine Paarungsprognose. Eine empirisch belegte Vorhersagegüte wird nicht behauptet.</p><h3>Historische Positionen und Aufstellung</h3><p>Die Positionen 1 bis 8 werden je Einzelblock aus vollständigen Spielberichten rekonstruiert. Wenn keine eindeutige Positionsnummer existiert, wird die API-Reihenfolge als Annahme verwendet. Ein Spielerprofil zeigt P(Position | Einzeleinsatz), geglättet mit einem Prior und nach Aktualität gewichtet. Die Positionsfavoriten nutzen zusätzlich die historische Auftrittsschätzung und sind heuristische normierte Anteile, keine kalibrierte Wahrscheinlichkeit für eine komplette Aufstellung. Spieler ohne Historie können nicht eingeordnet werden.</p><h3>Taktik-Assistent</h3><p>Die Taktik erzeugt aus acht bis sechzehn ausgewählten Gegnern vollständige Einzelblöcke mit acht unterschiedlichen Spielern. Für jeden Block werden 96 plausible Aufstellungen aus Teilnahme- und Positionshäufigkeiten gezogen. Die Aufstellungsoptimierung nutzt dieselben Bradley-Terry-Einzelchancen wie die Einzelpaarungen. Die Modi Ausgewogen, Angriff, Sicherheit und Überraschung bewerten jeweils den Durchschnitt, die Chance auf mindestens fünf Siege, ungünstige Szenarien bzw. die Chance auf mindestens sieben Siege. Die nichtlinearen Modi nutzen eine lokale Suche; globale Optimalität wird nicht behauptet. Diese Chancen sind unkalibriert und setzen unabhängige Einzelergebnisse innerhalb jedes gezogenen Szenarios voraus.</p><h3>Optimale Zuordnung</h3><p>Eine exakte dynamische Programmierung maximiert die Summe der Chancen für genau die ausgewählten Spieler. Jeder eigene Spieler spielt einmal; jeder Gegner höchstens einmal. Bei mehr Gegnern bleiben überzählige Gegner ungenutzt. Die Summe ist die erwartete Anzahl Einzelsiege, keine Mannschafts-Siegwahrscheinlichkeit. Auftritt und Siegchance werden nicht miteinander vermischt.</p><h3>Ligamodus und Grenzen</h3><p>Beobachtet wurden 8 Einzel, 4 Doppel und 8 Einzel, Best of 5 Legs sowie verdeckte Aufstellungen (BLIND_WO_LINEUP). Gewünschte direkte Paarungen sind damit nicht garantiert herstellbar. Das Tool optimiert einen freien Einzelblock; es erstellt keine vollständige regelkonforme Aufstellung über 20 Teilspiele und optimiert keine Doppel oder Wiedereinsätze.</p><h3>Identität und Average</h3><p>Kader und Ergebnisse werden über member.id zugeordnet. Da Spielberichte wechselnde Teilnehmer-IDs ohne stabile Mitglieds-ID liefern, werden Berichtsnamen eindeutig innerhalb des Teams abgeglichen. Nicht auflösbare Namen sperren den Bericht für Abwesenheitsschlüsse. Namensänderungen und Kaderwechsel können die Basis verkleinern. Der 3-Dart-Average ist 3 × Summe Score / Summe Darts, kein ungewichteter Durchschnitt von Spielwerten.</p><h3>Daten auf dieser Webseite</h3><p>Die Basisdaten werden aus der veröffentlichten JSON-Datei gelesen. Im Bereich Gegnerpositionen kann der Browser zusätzlich abgeschlossene Spielberichte direkt aus der 3K-Darts-API abrufen und lokal analysieren, sofern die API CORS erlaubt. „Datenstand neu laden“ lädt nur die veröffentlichte Datei erneut. Der Datenzeitpunkt steht auf jeder Seite. Das Browserdatum bestimmt, welches der geladenen Spiele noch bevorsteht. Namen und sportliche Statistiken werden bereitgestellt; Kontaktangaben und Passnummern werden nicht exportiert.</p>`;root.append(section);}

function tactics(root){
  const {own,opponent,match}=context();
  if(!opponent||!match){root.append(warning('Kein nächster Gegner vorhanden.'));return;}
  const positionReport=data.position_analyses?.[String(opponent.id)];
  const ours=candidates(own,match).filter(p=>p.strength!=null);
  const theirs=candidates(opponent,match).filter(p=>p.strength!=null);
  const chosenOwn=ownSet.size?ours.filter(p=>ownSet.has(p.id)):ours.slice(0,8);
  const chosenOpp=oppSet.size?theirs.filter(p=>oppSet.has(p.id)):theirs.slice(0,Math.min(12,theirs.length));
  const setup=card('Deine taktische Spielaufstellung','Verwendet die Spieler aus „Einzelpaarungen“. Ohne manuelle Auswahl werden die häufigsten verfügbaren Spieler vorgeschlagen.');
  const info=el('p','small',`${chosenOwn.length} eigene und ${chosenOpp.length} gegnerische Spieler gewählt · ${positionReport?.matches_used??0} historische Gegnerberichte.`);
  setup.append(info);
  if(!ownSet.size||!oppSet.size)setup.append(el('p','small','Automatische Vorauswahl: nach beobachteter Einsatzhäufigkeit sortiert. Passe sie bei Bedarf unter „Einzelpaarungen“ an.'));
  const navButtons=el('div','toolbar');
  navButtons.append(action('Spieler in Einzelpaarungen auswählen →',()=>{location.hash='pairings';}));
  if(!positionReport?.matches_used){
    setup.append(warning('Für diesen Gegner fehlen Positionsdaten. Lade zunächst die Spielberichte im Bereich „Gegnerpositionen“.'));
    navButtons.append(action('Zur Positionsanalyse →',()=>{location.hash='positions';},'primary'));
    setup.append(navButtons);root.append(setup);return;
  }
  if(chosenOwn.length!==8||chosenOpp.length<8||chosenOpp.length>16){
    setup.append(warning('Für eine taktische Aufstellung sind genau 8 eigene Spieler und 8–16 Gegenspieler mit auswertbaren Einzeln notwendig.'));
    setup.append(navButtons);root.append(setup);return;
  }
  const controls=el('div','tactic-controls');
  const blockLabel=el('label','', 'Einzelblock');
  const blockSelect=el('select');blockSelect.setAttribute('aria-label','Einzelblock');
  for(const [value,label] of [[0,'1. Einzelblock'],[1,'2. Einzelblock']]){const option=el('option','',label);option.value=String(value);blockSelect.append(option);}
  blockSelect.value=String(tacticBlock);
  blockSelect.addEventListener('change',()=>{tacticBlock=Number(blockSelect.value);tacticResults=null;render();});
  blockLabel.append(blockSelect);controls.append(blockLabel);
  const run=action('Taktiken berechnen ↗',()=>{
    try{
      const scenarios=predictOpponentLineups(chosenOpp,positionReport,{block:tacticBlock,samples:96});
      tacticResults={...compareStrategies(chosenOwn,scenarios),ownIds:chosenOwn.map(p=>p.id),oppIds:chosenOpp.map(p=>p.id),focus,opponentId:opponent.id,block:tacticBlock,analysed:positionReport.matches_used};
      render();
    }catch(error){output.replaceChildren(el('div','error',error.message));}
  },'primary');controls.append(run);setup.append(controls,navButtons);
  setup.append(el('p','small','Die Gegneraufstellungen sind modellierte Szenarien, keine realen Aufstellungen. Es werden pro Einzelblock 96 vollständige Möglichkeiten gezogen; jede Position wird genau einmal besetzt. Beide Einzelblöcke können sich unterscheiden.'));
  root.append(setup);
  const output=el('div');root.append(output);
  const valid=tacticResults&&tacticResults.focus===focus&&tacticResults.opponentId===opponent.id&&tacticResults.block===tacticBlock&&tacticResults.analysed===positionReport.matches_used&&JSON.stringify(tacticResults.ownIds)===JSON.stringify(chosenOwn.map(p=>p.id))&&JSON.stringify(tacticResults.oppIds)===JSON.stringify(chosenOpp.map(p=>p.id));
  if(!valid){output.append(empty('Starte die Berechnung, um vier taktische Aufstellungen zu vergleichen.'));return;}
  const selector=card('Taktik auswählen','Jeder Modus verwendet dieselben Gegner-Szenarien, optimiert aber ein anderes Ziel.');
  const tabs=el('div','tactic-mode-grid');
  for(const [key,config] of Object.entries(TACTICS)){
    const button=action(config.title,()=>{tacticMode=key;render();},'tactic-mode'+(tacticMode===key?' is-active':''));
    button.setAttribute('aria-pressed',String(tacticMode===key));tabs.append(button);
  }
  selector.append(tabs);selector.append(el('p','small',TACTICS[tacticMode].description));output.append(selector);
  const plan=tacticResults.strategies.find(s=>s.strategy===tacticMode);
  const stats=el('div','tactic-metrics');
  stats.append(metric('Erwartete Einzelsiege',fmt(plan.expected)+' / 8','Durchschnitt über 96 Gegneraufstellungen'),metric('Ungünstige Szenarien',fmt(plan.downside)+' / 8','10-%-Quantil der erwarteten Einzelsiege'),metric('Mindestens 5 Siege',percent(plan.prob5),'Geschätzte Chance im Einzelblock'),metric('Mindestens 7 Siege',percent(plan.prob7),'Geschätzte Chance im Einzelblock'));
  output.append(stats);
  const lineup=card('Empfohlene Reihenfolge',`${TACTICS[tacticMode].title} · ${tacticBlock+1}. Einzelblock`);
  const list=el('div','tactic-lineup');
  for(const slot of plan.positions){
    const row=el('div','tactic-row');
    row.append(el('span','tactic-slot','POS '+slot.position),el('span','tactic-player',slot.player.name),el('strong','',percent(slot.win_probability)));
    const bar=el('div','tactic-bar');const fill=el('span');fill.style.width=(100*slot.win_probability).toFixed(1)+'%';bar.append(fill);row.append(bar);list.append(row);
  }
  lineup.append(list,el('p','small','Die Siegchance jeder Position ist der Mittelwert aus den modellierten Gegneraufstellungen, nicht die Chance gegen einen sicher bekannten Gegner.'));
  output.append(lineup);
  const comparison=card('Strategien im Vergleich');
  comparison.append(table([col('Taktik','strategy',false,r=>TACTICS[r.strategy].title),col('Erwartete Siege','expected',true,r=>fmt(r.expected)),col('Unteres 10%-Quantil','downside',true,r=>fmt(r.downside)),col('P(≥ 5 Siege)','prob5',true,r=>percent(r.prob5)),col('P(≥ 7 Siege)','prob7',true,r=>percent(r.prob7))],tacticResults.strategies,{label:'Taktikvergleich'}));
  comparison.append(el('p','small','Ausgewogen = Erwartungswert minus Risikomalus; Angriff = Chance auf mindestens 5 Einzelsiege; Sicherheit = unteres 10%-Quantil; Überraschung = Chance auf mindestens 7 Einzelsiege. Für nichtlineare Ziele nutzt die App eine lokale Tauschsuche mit mehreren Startpunkten: gut, aber nicht garantiert global optimal.'));
  output.append(comparison);
}

const views={tactics,overview,teams:standings,players,details,matches:relevantMatches,positions,pairings,performances,statistics,quality,method};
async function load(){const button=$('#reload');button.disabled=true;try{const response=await fetch(new URL('./data/league.json',import.meta.url),{cache:'no-store'});if(!response.ok)throw new Error(`Daten konnten nicht geladen werden (HTTP ${response.status}).`);const next=await response.json();if(next.schema!==1||next.event_id!==1570||!next.teams.some(t=>t.id===DEFAULT_TEAM))throw new Error('Ungültiger Datenstand: RSV oder Event 1570 fehlt.');data=next;if(!team(focus))focus=DEFAULT_TEAM;lastPlan=null;tacticResults=null;ownSet.clear();oppSet.clear();const select=$('#focus');clear(select);for(const t of data.teams){const op=el('option','',t.name);op.value=String(t.id);op.selected=t.id===focus;select.append(op);}$('#season').textContent=`3K-Darts · ${data.season}`;render();}catch(e){if(!data)$('#content').replaceChildren(empty('Daten nicht verfügbar. Bitte über einen Webserver öffnen (siehe README).'));showError(e);}finally{button.disabled=false;}}
$('#reload').addEventListener('click',load);
$('#focus').addEventListener('change',e=>{focus=Number(e.target.value);lastPlan=null;tacticResults=null;selectedPlayer=null;ownSet.clear();oppSet.clear();render();});
$('#reset').addEventListener('click',()=>{focus=DEFAULT_TEAM;$('#focus').value=String(focus);lastPlan=null;tacticResults=null;selectedPlayer=null;ownSet.clear();oppSet.clear();render();});
$('#export').addEventListener('click',()=>{if(!data)return;const report={event_id:1570,focus:team(focus).name,data_as_of:data.as_of,exported_at:new Date().toISOString(),scenario:lastPlan,tactical_plan:tacticResults?{block:tacticResults.block+1,samples:tacticResults.samples,strategies:tacticResults.strategies.map(s=>({strategy:s.strategy,expected:s.expected,downside:s.downside,prob5:s.prob5,prob7:s.prob7,positions:s.positions.map(p=>({position:p.position,player:p.player.name,win_probability:p.win_probability}))}))}:null,opponent_position_analysis:data.position_analyses?.[String(context().opponent?.id)]??null,players:playerRecords(),sources:data.sources,method:'Auftritt (k+1)/(n+2); Einzelstärke (Siege+2)/(Spiele+4); Bradley-Terry-Odds; exakte Zuordnung; unkalibriertes bedingtes Einzelszenario.'};const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='rsv-analyse.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('hashchange',render);
load();
