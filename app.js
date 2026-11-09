// Mana Tracker - preview version
// Market data is live from Scryfall. Listings, chat and map are demo features stored in localStorage
// until a backend (e.g. Supabase) is connected.

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Tabs ----------
let mapReady = false;
function showTab(id) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
  if (id === 'map') initMap();
  if (id === 'market' && !$('#marketGrid').children.length) runSearch('usd>1000');
  window.scrollTo(0, 0);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

// ---------- Market (live Scryfall) ----------
async function runSearch(q) {
  const status = $('#marketStatus');
  const grid = $('#marketGrid');
  status.textContent = 'Loading prices...';
  grid.innerHTML = '';
  try {
    const url = `https://api.scryfall.com/cards/search?order=usd&dir=desc&unique=cards&q=${encodeURIComponent(q + ' game:paper')}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.data) { status.textContent = 'No cards found. Try another search.'; return; }
    const cards = data.data.slice(0, 40);
    status.textContent = `Showing ${cards.length} of ${data.total_cards} cards, highest price first`;
    grid.innerHTML = cards.map(cardTile).join('');
  } catch (e) {
    status.textContent = 'Could not load prices right now. Try again in a moment.';
  }
}
function cardTile(c) {
  const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '';
  const usd = c.prices?.usd ? `$${Number(c.prices.usd).toLocaleString()}` : (c.prices?.usd_foil ? `$${Number(c.prices.usd_foil).toLocaleString()} foil` : 'No price');
  return `<div class="card">
    ${img ? `<img loading="lazy" src="${img}" alt="${esc(c.name)}">` : ''}
    <div class="name">${esc(c.name)}</div>
    <div class="meta">${esc(c.set_name)} · ${esc(c.rarity)}</div>
    <div class="price">${usd}</div>
    <button class="btn" onclick="quickList('${esc(c.name).replace(/'/g, "\\'")}','${c.prices?.usd || ''}')">List this card</button>
  </div>`;
}
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#searchInput').value.trim();
  if (v) runSearch(v);
});
$$('.chip').forEach((c) => c.addEventListener('click', () => runSearch(c.dataset.q)));

// ---------- Listings (demo) ----------
const demoListings = [
  { card: 'Myrel, Shield of Argive', type: 'For sale', price: '$18', condition: 'Near Mint', seller: 'SoldierSam', city: 'Hartford, CT' },
  { card: 'Skullclamp', type: 'For trade', price: 'Want: Cathars\' Crusade', condition: 'Lightly Played', seller: 'ClampQueen', city: 'New Haven, CT' },
  { card: 'Anointed Procession', type: 'For sale', price: '$55', condition: 'Near Mint', seller: 'TokenTim', city: 'Springfield, MA' },
  { card: 'The One Ring', type: 'Looking for', price: 'Up to $95', condition: 'Any', seller: 'RingSeeker', city: 'Providence, RI' },
  { card: 'Sol Ring', type: 'For sale', price: '$1', condition: 'Moderately Played', seller: 'BudgetBrew', city: 'Waterbury, CT' },
];
let listings = store.get('mt_listings', demoListings);
function renderListings() {
  const f = $('#listingFilter').value.toLowerCase();
  const t = $('#typeFilter').value;
  const shown = listings.filter((l) => (!t || l.type === t) && (l.card + l.seller + l.city).toLowerCase().includes(f));
  $('#listings').innerHTML = shown.map((l) => `<div class="card">
    <span class="badge">${esc(l.type)}</span>
    <div class="name">${esc(l.card)}</div>
    <div class="price">${esc(l.price)}</div>
    <div class="meta">${esc(l.condition)} · ${esc(l.seller)}${l.city ? ' · ' + esc(l.city) : ''}</div>
    <button class="btn" onclick="messageSeller('${esc(l.seller).replace(/'/g, "\\'")}','${esc(l.card).replace(/'/g, "\\'")}')">Message seller</button>
  </div>`).join('') || '<p class="status">No listings match.</p>';
}
$('#newListingBtn').addEventListener('click', () => $('#listingForm').classList.toggle('hidden'));
$('#listingForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  listings.unshift(d);
  store.set('mt_listings', listings);
  e.target.reset();
  e.target.classList.add('hidden');
  renderListings();
});
$('#listingFilter').addEventListener('input', renderListings);
$('#typeFilter').addEventListener('change', renderListings);
window.quickList = (name, usd) => {
  showTab('trade');
  const f = $('#listingForm');
  f.classList.remove('hidden');
  f.card.value = name;
  f.price.value = usd ? `$${usd}` : '';
};

// ---------- Chat (demo) ----------
let convos = store.get('mt_convos', {
  SoldierSam: [{ from: 'them', text: 'Hey! Myrel is still available if you want it.' }],
  ClampQueen: [{ from: 'them', text: 'Would you trade a Cathars\' Crusade for my Skullclamp?' }],
});
let activeConvo = null;
function renderConvos() {
  $('#convoList').innerHTML = Object.keys(convos).map((n) => {
    const last = convos[n][convos[n].length - 1];
    return `<div class="convo ${n === activeConvo ? 'active' : ''}" onclick="openConvo('${esc(n).replace(/'/g, "\\'")}')">
      <div><b>${esc(n)}</b></div><div class="meta">${esc(last?.text || '')}</div></div>`;
  }).join('') || '<div class="convo">No messages yet</div>';
}
window.openConvo = (n) => {
  activeConvo = n;
  $('#chatHeader').textContent = n;
  $('#chatMessages').innerHTML = convos[n].map((m) => `<div class="msg ${m.from === 'me' ? 'me' : ''}">${esc(m.text)}</div>`).join('');
  $('#chatMessages').scrollTop = 1e9;
  renderConvos();
};
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (!v || !activeConvo) return;
  convos[activeConvo].push({ from: 'me', text: v });
  store.set('mt_convos', convos);
  $('#chatInput').value = '';
  openConvo(activeConvo);
});
window.messageSeller = (seller, card) => {
  if (!convos[seller]) convos[seller] = [];
  if (!convos[seller].length) convos[seller].push({ from: 'me', text: `Hi! Is your ${card} still available?` });
  store.set('mt_convos', convos);
  showTab('chat');
  openConvo(seller);
};

// ---------- Map (demo traders) ----------
const traders = [
  { name: 'SoldierSam', lat: 41.7658, lng: -72.6734, deck: 'Myrel soldiers', city: 'Hartford, CT' },
  { name: 'ClampQueen', lat: 41.3083, lng: -72.9279, deck: 'Edgar Markov', city: 'New Haven, CT' },
  { name: 'TokenTim', lat: 42.1015, lng: -72.5898, deck: 'Rhys the Redeemed', city: 'Springfield, MA' },
  { name: 'RingSeeker', lat: 41.824, lng: -71.4128, deck: 'Atraxa', city: 'Providence, RI' },
  { name: 'BudgetBrew', lat: 41.5582, lng: -73.0515, deck: 'Krenko', city: 'Waterbury, CT' },
];
let map;
let friends = store.get('mt_friends', []);
function initMap() {
  if (mapReady) { setTimeout(() => map.invalidateSize(), 100); return; }
  mapReady = true;
  map = L.map('mapView').setView([41.7, -72.7], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  traders.forEach((t) => L.marker([t.lat, t.lng]).addTo(map).bindPopup(`<b>${t.name}</b><br>${t.city}<br>Plays: ${t.deck}`));
  renderNearby();
}
function dist(a, b, c, d) {
  const R = 3958.8, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function renderNearby(me) {
  const list = traders.map((t) => ({ ...t, miles: me ? dist(me.lat, me.lng, t.lat, t.lng) : null }))
    .sort((a, b) => (a.miles ?? 0) - (b.miles ?? 0));
  $('#nearbyList').innerHTML = list.map((t) => `<div class="card">
    <div class="name">${esc(t.name)}</div>
    <div class="meta">${esc(t.city)}${t.miles != null ? ' · ' + t.miles.toFixed(0) + ' mi away' : ''}</div>
    <div class="meta">Plays: ${esc(t.deck)}</div>
    <button class="btn" onclick="addFriend('${t.name}')">${friends.includes(t.name) ? 'Added' : 'Add trader'}</button>
    <button class="btn" onclick="messageSeller('${t.name}','cards')">Message</button>
  </div>`).join('');
}
window.addFriend = (n) => {
  if (!friends.includes(n)) friends.push(n);
  store.set('mt_friends', friends);
  renderNearby(window._me);
};
$('#locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Location is not available on this device.');
  navigator.geolocation.getCurrentPosition((p) => {
    const me = { lat: p.coords.latitude, lng: p.coords.longitude };
    window._me = me;
    L.circleMarker([me.lat, me.lng], { radius: 9, color: '#c9a227' }).addTo(map).bindPopup('You are here').openPopup();
    map.setView([me.lat, me.lng], 9);
    renderNearby(me);
  }, () => alert('Could not get your location.'));
});

// ---------- Start ----------
renderListings();
renderConvos();
