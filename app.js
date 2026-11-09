// Mana Tracker
// Market: live Scryfall data. Accounts, listings, chat and map: Supabase.

const SUPABASE_URL = 'https://txmeggmwqyfcnnsiexck.supabase.co';
const SUPABASE_KEY = 'sb_publishable_38gPNXOs2k7zLumLuQYfpQ_UBq_E3D8';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { const s = (Date.now() - new Date(t)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };

let user = null;      // auth user
let profile = null;   // my profile row
let profilesById = {};

// Profile picture bubble (falls back to the first letter of the username)
function avatarHtml(p, size = '') {
  const name = p?.username || '?';
  const url = p?.avatar_url;
  return url
    ? `<span class="avatar ${size}" style="background-image:url('${esc(url)}')"></span>`
    : `<span class="avatar ${size}">${esc(name[0].toUpperCase())}</span>`;
}

// ---------- Tabs ----------
let mapReady = false;
function showTab(id) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
  if (id === 'map') initMap();
  if (id === 'market' && !$('#marketGrid').children.length) runSearch('usd>1000');
  if (id === 'trade') loadListings();
  if (id === 'chat') { $('#unreadDot').classList.add('hidden'); loadConvos(); }
  if (id === 'account' && user) loadMyListings();
  window.scrollTo(0, 0);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

function requireLogin(msg) {
  if (user) return true;
  showTab('account');
  $('#authMsg').textContent = msg || 'Sign in or create an account first.';
  return false;
}

// ---------- Auth ----------
let signUpMode = true;
function setAuthMode(up) {
  signUpMode = up;
  $('#authTitle').textContent = up ? 'Create your account' : 'Sign in';
  $('#authSubmit').textContent = up ? 'Sign up' : 'Sign in';
  $('#authUsername').classList.toggle('hidden', !up);
  $('#authCity').classList.toggle('hidden', !up);
  $('#authToggle').textContent = up ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('#authMsg').textContent = '';
}
$('#authToggle').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(!signUpMode); });
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  $('#authMsg').textContent = 'Working...';
  if (signUpMode) {
    const username = (d.username || '').trim();
    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) { $('#authMsg').textContent = 'Username must be 3-24 letters, numbers or underscores.'; return; }
    const { data: taken } = await sb.from('profiles').select('id').ilike('username', username).maybeSingle();
    if (taken) { $('#authMsg').textContent = 'That username is taken.'; return; }
    const { error } = await sb.auth.signUp({ email: d.email, password: d.password, options: { data: { username, city: d.city || null } } });
    $('#authMsg').textContent = error ? error.message : 'Account created! You are signed in.';
  } else {
    const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.password });
    $('#authMsg').textContent = error ? error.message : '';
  }
});
$('#signOutBtn').addEventListener('click', async () => { await sb.auth.signOut(); showTab('home'); });

// Supabase recommends not awaiting other calls directly inside this callback, so defer the work
sb.auth.onAuthStateChange((_evt, session) => { setTimeout(() => handleAuth(session), 0); });
async function handleAuth(session) {
  user = session?.user || null;
  if (user) {
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    profile = data;
    $('#accountTab').textContent = profile ? '@' + profile.username : 'Account';
    $('#heroJoin').classList.add('hidden');
    $('#authBox').classList.add('hidden');
    $('#profileBox').classList.remove('hidden');
    fillProfileForm();
    updateHeader();
    subscribeMessages();
  } else {
    profile = null;
    $('#accountTab').textContent = 'Sign in';
    $('#heroJoin').classList.remove('hidden');
    $('#authBox').classList.remove('hidden');
    $('#profileBox').classList.add('hidden');
    updateHeader();
    unsubscribeMessages();
  }
  $('#chatGate').classList.toggle('hidden', !!user);
  $('#chatWrap').classList.toggle('hidden', !user);
}

// ---------- Header profile picture ----------
function updateHeader() {
  const h = $('#headerAvatar');
  if (user && profile) {
    h.innerHTML = avatarHtml(profile);
    h.classList.remove('hidden');
    $('#accountTab').classList.add('hidden');
  } else {
    h.classList.add('hidden');
    $('#accountTab').classList.remove('hidden');
  }
  $('#noteForm').classList.toggle('hidden', !user);
  $('#noteInput').value = profile?.note || '';
}

// ---------- Profile ----------
let pendingLoc = null;
function fillProfileForm() {
  if (!profile) return;
  const f = $('#profileForm');
  f.username.value = profile.username || '';
  f.city.value = profile.city || '';
  f.deck.value = profile.deck || '';
  f.note.value = profile.note || '';
  f.show_on_map.checked = !!profile.show_on_map;
  $('#avatarPreview').outerHTML = avatarHtml(profile, 'xl').replace('<span class="avatar xl"', '<span id="avatarPreview" class="avatar xl"');
  $('#locMsg').textContent = profile.lat ? 'Location saved (approximate).' : 'No location saved yet.';
}

// ---------- Profile picture upload ----------
// Shrinks the photo to a 256px square before uploading so it loads fast
function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => reject(new Error('That file is not a supported image'));
    img.src = URL.createObjectURL(file);
  });
}
$('#avatarInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !user) return;
  $('#avatarMsg').textContent = 'Uploading...';
  try {
    const blob = await resizeImage(file);
    const path = `${user.id}/avatar.jpg`;
    const { error: upErr } = await sb.storage.from('avatars').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (upErr) throw upErr;
    const { data: pub } = sb.storage.from('avatars').getPublicUrl(path);
    const avatar_url = pub.publicUrl + '?v=' + Date.now();
    const { data, error } = await sb.from('profiles').update({ avatar_url }).eq('id', user.id).select().single();
    if (error) throw error;
    profile = data;
    profilesById[user.id] = data;
    fillProfileForm();
    updateHeader();
    $('#avatarMsg').textContent = 'Looking good!';
    if (mapReady) loadMapPlayers();
  } catch (err) {
    $('#avatarMsg').textContent = 'Upload failed: ' + (err.message || err);
  }
  e.target.value = '';
});
// Round to roughly 3 miles so exact homes are never shown
const fuzz = (n) => Math.round(n * 20) / 20;
$('#setLocBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { $('#locMsg').textContent = 'Location is not available on this device.'; return; }
  $('#locMsg').textContent = 'Getting location...';
  navigator.geolocation.getCurrentPosition((p) => {
    pendingLoc = { lat: fuzz(p.coords.latitude), lng: fuzz(p.coords.longitude) };
    $('#locMsg').textContent = 'Got it. Tap Save profile to keep it.';
  }, () => { $('#locMsg').textContent = 'Could not get your location.'; });
});
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const username = f.username.value.trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) { $('#profileMsg').textContent = 'Username must be 3-24 letters, numbers or underscores.'; return; }
  const upd = { username, city: f.city.value.trim() || null, deck: f.deck.value.trim() || null, note: f.note.value.trim().slice(0, 50) || null, show_on_map: f.show_on_map.checked };
  if (pendingLoc) Object.assign(upd, pendingLoc);
  const { data, error } = await sb.from('profiles').update(upd).eq('id', user.id).select().single();
  if (error) { $('#profileMsg').textContent = error.message.includes('duplicate') ? 'That username is taken.' : error.message; return; }
  profile = data; pendingLoc = null;
  $('#accountTab').textContent = '@' + profile.username;
  $('#profileMsg').textContent = 'Saved!';
  fillProfileForm();
  updateHeader();
  if (mapReady) loadMapPlayers();
});

// ---------- Market (live Scryfall) ----------
async function runSearch(q) {
  const status = $('#marketStatus');
  const grid = $('#marketGrid');
  status.textContent = 'Loading prices...';
  grid.innerHTML = '';
  try {
    const url = `https://api.scryfall.com/cards/search?order=usd&dir=desc&unique=cards&q=${encodeURIComponent(q + ' game:paper')}`;
    const data = await (await fetch(url)).json();
    if (!data.data) { status.textContent = 'No cards found. Try another search.'; return; }
    const cards = data.data.slice(0, 40);
    status.textContent = `Showing ${cards.length} of ${data.total_cards} cards, highest price first`;
    grid.innerHTML = cards.map(cardTile).join('');
  } catch { status.textContent = 'Could not load prices right now. Try again in a moment.'; }
}
function cardTile(c) {
  const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '';
  const usd = c.prices?.usd ? `$${Number(c.prices.usd).toLocaleString()}` : (c.prices?.usd_foil ? `$${Number(c.prices.usd_foil).toLocaleString()} foil` : 'No price');
  return `<div class="card">
    ${img ? `<img loading="lazy" src="${img}" alt="${esc(c.name)}">` : ''}
    <div class="name">${esc(c.name)}</div>
    <div class="meta">${esc(c.set_name)} · ${esc(c.rarity)}</div>
    <div class="price">${usd}</div>
    <button class="btn" data-quick="${esc(c.name)}" data-usd="${c.prices?.usd || ''}">List this card</button>
  </div>`;
}
$('#marketGrid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quick]');
  if (!b) return;
  if (!requireLogin('Sign in to list a card.')) return;
  showTab('trade');
  openListingForm();
  setCat('single');
  const f = $('#listingForm');
  f.card.value = b.dataset.quick;
  f.price.value = b.dataset.usd ? `$${b.dataset.usd}` : '';
  lookupCard(b.dataset.quick);
});
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#searchInput').value.trim(); if (v) runSearch(v); });
$$('.chip').forEach((c) => c.addEventListener('click', () => runSearch(c.dataset.q)));

// ---------- Listings ----------
let listings = [];
const CAT_LABEL = { single: 'Single', lot: 'Bulk lot', deck: 'Deck' };
async function loadListings() {
  $('#listings').innerHTML = '<p class="status">Loading listings...</p>';
  const { data, error } = await sb.from('listings').select('*, profiles(username, city, avatar_url)').order('created_at', { ascending: false }).limit(200);
  if (error) { $('#listings').innerHTML = '<p class="status">Could not load listings.</p>'; return; }
  listings = data;
  renderListings();
}
function listingCard(l, mine) {
  const seller = l.profiles?.username || 'player';
  const photos = l.photos || [];
  const cover = photos[0] || l.card_image;
  const coverCls = !photos[0] && l.card_image ? 'cover cardimg' : 'cover';
  return `<div class="card">
    ${cover ? `<a href="${esc(cover)}" target="_blank" rel="noopener"><img class="${coverCls}" loading="lazy" src="${esc(cover)}" alt="${esc(l.card)}"></a>` : ''}
    ${photos.length > 1 ? `<div class="thumbs">${photos.slice(1).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="photo"></a>`).join('')}</div>` : ''}
    <div><span class="badge">${esc(l.type)}</span><span class="badge cat">${CAT_LABEL[l.category] || 'Single'}</span></div>
    <div class="name">${esc(l.card)}</div>
    <div class="price">${esc(l.price || '')}</div>
    ${l.category === 'lot' && l.quantity ? `<div class="meta">${Number(l.quantity).toLocaleString()} cards</div>` : ''}
    ${l.category === 'single' && l.condition ? `<div class="meta">${esc(l.condition)}</div>` : ''}
    <div class="meta who">${avatarHtml(l.profiles)} @${esc(seller)}${l.city ? ' · ' + esc(l.city) : ''}</div>
    <div class="meta">${ago(l.created_at)}</div>
    ${mine || (user && l.user_id === user.id) ? `<button class="btn danger" data-del="${l.id}">Take down post</button>`
      : (false ? ''
      : `<button class="btn" data-msg="${l.user_id}" data-card="${esc(l.card)}" data-listing="${l.id}">Message seller</button>`)}
  </div>`;
}
function renderListings() {
  const f = $('#listingFilter').value.toLowerCase();
  const t = $('#typeFilter').value;
  const k = $('#catFilter').value;
  const shown = listings.filter((l) => (!t || l.type === t) && (!k || (l.category || 'single') === k) && (l.card + ' ' + (l.profiles?.username || '') + ' ' + (l.city || '')).toLowerCase().includes(f));
  $('#listings').innerHTML = shown.map((l) => listingCard(l, false)).join('') || '<p class="status">No listings yet. Be the first to post one!</p>';
}

// Selling form: single card / bulk lot / deck
let listCat = 'single';
let foundCard = null;   // card matched on Scryfall
let photoFiles = [];
function setCat(cat) {
  listCat = cat;
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
  $$('.cat').forEach((el) => el.classList.toggle('hidden', !el.classList.contains('cat-' + cat)));
}
$$('.seg-btn').forEach((b) => b.addEventListener('click', () => setCat(b.dataset.cat)));
function openListingForm() {
  const f = $('#listingForm');
  f.classList.remove('hidden');
  if (!f.city.value) f.city.value = profile?.city || '';
}
$('#newListingBtn').addEventListener('click', () => {
  if (!requireLogin('Sign in to list a card.')) return;
  const f = $('#listingForm');
  if (f.classList.contains('hidden')) openListingForm(); else f.classList.add('hidden');
});

// Card name autocomplete and lookup (Scryfall)
let acTimer, lookupTimer;
$('#cardSearch').addEventListener('input', (e) => {
  foundCard = null;
  const q = e.target.value.trim();
  clearTimeout(acTimer); clearTimeout(lookupTimer);
  if (q.length < 2) { $('#cardFound').innerHTML = ''; return; }
  acTimer = setTimeout(async () => {
    try {
      const r = await (await fetch('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(q))).json();
      $('#cardSuggest').innerHTML = (r.data || []).slice(0, 10).map((n) => `<option value="${esc(n)}">`).join('');
    } catch {}
  }, 250);
  lookupTimer = setTimeout(() => lookupCard(q), 900);
});
$('#cardSearch').addEventListener('change', (e) => lookupCard(e.target.value.trim()));
async function lookupCard(q) {
  if (!q) return;
  $('#cardFound').textContent = 'Finding card...';
  try {
    const res = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(q));
    const c = await res.json();
    if (c.object !== 'card') { foundCard = null; $('#cardFound').textContent = 'Card not found. Check the spelling.'; return; }
    const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '';
    foundCard = { name: c.name, id: c.id, image: img, usd: c.prices?.usd };
    $('#cardFound').innerHTML = `${img ? `<img src="${img}" alt="">` : ''}<div><b>${esc(c.name)}</b><br>${esc(c.set_name)}${c.prices?.usd ? '<br>Market price: $' + c.prices.usd : ''}</div>`;
    if ($('#cardSearch').value.trim().toLowerCase() !== c.name.toLowerCase()) $('#cardSearch').value = c.name;
  } catch { $('#cardFound').textContent = 'Could not look up that card right now.'; }
}

// Photos
$('#photoInput').addEventListener('change', (e) => {
  photoFiles = [...e.target.files].slice(0, 4);
  $('#photoPreview').innerHTML = photoFiles.map((f) => `<img src="${URL.createObjectURL(f)}" alt="">`).join('');
  $('#photoCount').textContent = photoFiles.length ? `${photoFiles.length} photo${photoFiles.length > 1 ? 's' : ''} added` : 'No photos added yet';
  if (e.target.files.length > 4) $('#listingMsg').textContent = 'Only the first 4 photos will be used.';
});
function resizeTo(file, max = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => reject(new Error('One of the photos is not a supported image'));
    img.src = URL.createObjectURL(file);
  });
}
async function uploadPhotos() {
  const urls = [];
  for (let i = 0; i < photoFiles.length; i++) {
    const blob = await resizeTo(photoFiles[i]);
    const path = `${user.id}/${Date.now()}-${i}.jpg`;
    const { error } = await sb.storage.from('listing-photos').upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    urls.push(sb.storage.from('listing-photos').getPublicUrl(path).data.publicUrl);
  }
  return urls;
}

$('#listingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const msg = $('#listingMsg');
  const type = f.type.value;
  const price = f.price.value.trim();
  const needPhotos = type !== 'Looking for';
  const row = { category: listCat, type, price: price || null, city: f.city.value.trim() || null };
  if (listCat === 'single') {
    if (!foundCard) await lookupCard(f.card.value.trim());
    if (!foundCard) { msg.textContent = 'Type a card name and pick the right card first.'; return; }
    Object.assign(row, { card: foundCard.name, scryfall_id: foundCard.id, card_image: foundCard.image, condition: f.condition.value });
  } else if (listCat === 'lot') {
    const qty = parseInt(f.quantity.value, 10);
    if (!qty || qty < 1) { msg.textContent = 'Enter how many cards are in the lot.'; return; }
    Object.assign(row, { card: f.lot_title.value.trim() || `${qty} card bulk lot`, quantity: qty });
  } else {
    const name = f.deck_name.value.trim();
    if (!name) { msg.textContent = 'Enter the deck name.'; return; }
    row.card = name;
  }
  if (!price) { msg.textContent = type === 'For trade' ? 'Say what you want in trade.' : 'Enter how much you want for it.'; return; }
  if (needPhotos && !photoFiles.length) { msg.textContent = 'Add at least one photo.'; return; }
  $('#postBtn').disabled = true;
  msg.textContent = photoFiles.length ? 'Uploading photos...' : 'Posting...';
  try {
    row.photos = await uploadPhotos();
    const { error } = await sb.from('listings').insert(row);
    if (error) throw error;
    f.reset(); photoFiles = []; foundCard = null;
    $('#photoPreview').innerHTML = ''; $('#cardFound').innerHTML = ''; $('#photoCount').textContent = 'No photos added yet';
    msg.textContent = '';
    f.classList.add('hidden');
    setCat('single');
    loadListings();
  } catch (err) {
    msg.textContent = 'Could not post: ' + (err.message || err);
  }
  $('#postBtn').disabled = false;
});
$('#listingFilter').addEventListener('input', renderListings);
$('#typeFilter').addEventListener('change', renderListings);
$('#catFilter').addEventListener('change', renderListings);
async function loadMyListings() {
  const { data } = await sb.from('listings').select('*, profiles(username, city, avatar_url)').eq('user_id', user.id).order('created_at', { ascending: false });
  $('#myListings').innerHTML = (data || []).map((l) => listingCard(l, true)).join('') || '<p class="status">You have no listings yet.</p>';
}
document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del && confirm('Take down this post?')) {
    const { error } = await sb.from('listings').delete().eq('id', del.dataset.del);
    if (error) { alert('Could not take down post: ' + error.message); return; }
    listings = listings.filter((l) => String(l.id) !== del.dataset.del);
    renderListings();
    if (user) loadMyListings();
  }
  const msg = e.target.closest('[data-msg]');
  if (msg) {
    if (!requireLogin('Sign in to message players.')) return;
    startChat(msg.dataset.msg, msg.dataset.card ? `Hi! Is your ${msg.dataset.card} still available?` : '', msg.dataset.listing || null);
  }
  const add = e.target.closest('[data-add]');
  if (add) {
    if (!requireLogin('Sign in to add traders.')) return;
    await sb.from('friends').insert({ friend_id: add.dataset.add });
    if (mapReady) loadMapPlayers();
  }
  const rm = e.target.closest('[data-unadd]');
  if (rm) {
    await sb.from('friends').delete().eq('user_id', user.id).eq('friend_id', rm.dataset.unadd);
    if (mapReady) loadMapPlayers();
  }
});

// ---------- Chat ----------
let messages = [];
let activePartner = null;
let pendingListing = null;
let channel = null;
async function getProfiles(ids) {
  const need = ids.filter((id) => !profilesById[id]);
  if (need.length) {
    const { data } = await sb.from('profiles').select('id, username, city, avatar_url').in('id', need);
    (data || []).forEach((p) => { profilesById[p.id] = p; });
  }
}
async function loadConvos() {
  if (!user) return;
  const { data } = await sb.from('messages').select('*').or(`sender.eq.${user.id},recipient.eq.${user.id}`).order('created_at', { ascending: true }).limit(1000);
  messages = data || [];
  await getProfiles([...new Set(messages.map((m) => (m.sender === user.id ? m.recipient : m.sender)))]);
  renderConvos();
  if (activePartner) renderThread();
}
function renderConvos() {
  const last = {};
  messages.forEach((m) => { last[m.sender === user.id ? m.recipient : m.sender] = m; });
  if (activePartner && !last[activePartner]) last[activePartner] = null;
  const ids = Object.keys(last).sort((a, b) => new Date(last[b]?.created_at || Date.now()) - new Date(last[a]?.created_at || Date.now()));
  $('#convoList').innerHTML = ids.map((id) => `<div class="convo ${id === activePartner ? 'active' : ''}" data-convo="${id}">
      <div class="who">${avatarHtml(profilesById[id])}<b>@${esc(profilesById[id]?.username || 'player')}</b></div>
      <div class="meta">${esc(last[id]?.body || 'New conversation')}</div></div>`).join('') || '<div class="convo">No messages yet. Message a seller from Buy &amp; Trade.</div>';
}
function renderThread() {
  const p = profilesById[activePartner];
  $('#chatHeader').innerHTML = `<span class="who">${avatarHtml(p)} @${esc(p?.username || 'player')}${p?.city ? ' · ' + esc(p.city) : ''}</span>`;
  const thread = messages.filter((m) => m.sender === activePartner || m.recipient === activePartner);
  $('#chatMessages').innerHTML = thread.map((m) => `<div class="msg ${m.sender === user.id ? 'me' : ''}">${esc(m.body)}<div class="time">${ago(m.created_at)}</div></div>`).join('') || '<p class="status">Say hi!</p>';
  $('#chatMessages').scrollTop = 1e9;
}
$('#convoList').addEventListener('click', (e) => {
  const c = e.target.closest('[data-convo]');
  if (!c) return;
  activePartner = c.dataset.convo;
  pendingListing = null;
  renderConvos(); renderThread();
});
async function startChat(partnerId, draft, listingId) {
  await getProfiles([partnerId]);
  activePartner = partnerId;
  pendingListing = listingId;
  showTab('chat');
  $('#chatInput').value = draft || '';
  $('#chatInput').focus();
}
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('#chatInput').value.trim();
  if (!body || !activePartner || !user) return;
  $('#chatInput').value = '';
  const { data, error } = await sb.from('messages').insert({ recipient: activePartner, body, listing_id: pendingListing }).select().single();
  if (error) { alert('Could not send: ' + error.message); $('#chatInput').value = body; return; }
  pendingListing = null;
  if (!messages.find((m) => m.id === data.id)) messages.push(data);
  renderConvos(); renderThread();
});
function subscribeMessages() {
  unsubscribeMessages();
  channel = sb.channel('my-messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient=eq.${user.id}` }, async (payload) => {
      const m = payload.new;
      if (messages.find((x) => x.id === m.id)) return;
      messages.push(m);
      await getProfiles([m.sender]);
      if ($('#chat').classList.contains('active')) { renderConvos(); if (activePartner === m.sender) renderThread(); }
      else $('#unreadDot').classList.remove('hidden');
    })
    .subscribe();
}
function unsubscribeMessages() { if (channel) { sb.removeChannel(channel); channel = null; } }

// ---------- Map ----------
let map, playerLayer, meMarker;
let myPos = null;
function initMap() {
  if (mapReady) { setTimeout(() => map.invalidateSize(), 100); loadMapPlayers(); return; }
  mapReady = true;
  map = L.map('mapView').setView([39.8, -98.6], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  playerLayer = L.layerGroup().addTo(map);
  loadMapPlayers();
}
function dist(a, b, c, d) {
  const R = 3958.8, r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// Snapchat-style map pins: profile picture with the username under it
function pinIcon(p, isMe = false) {
  return L.divIcon({
    className: 'map-pin' + (isMe ? ' me' : ''),
    html: `<div class="pin-wrap">${p.note ? `<div class="pin-note">${esc(p.note)}</div>` : ''}${avatarHtml(p)}<div class="pin-name">${isMe ? 'You' : '@' + esc(p.username)}</div></div>`,
    iconSize: [150, p.note ? 110 : 70], iconAnchor: [75, p.note ? 75 : 35], popupAnchor: [0, -30],
  });
}
async function loadMapPlayers() {
  const { data: players } = await sb.from('profiles').select('id, username, city, deck, lat, lng, avatar_url, note').eq('show_on_map', true).not('lat', 'is', null).limit(1000);
  let friendIds = [];
  if (user) {
    const { data: fr } = await sb.from('friends').select('friend_id').eq('user_id', user.id);
    friendIds = (fr || []).map((f) => f.friend_id);
  }
  const list = (players || []).filter((p) => !user || p.id !== user.id)
    .map((p) => ({ ...p, miles: myPos ? dist(myPos.lat, myPos.lng, p.lat, p.lng) : null }))
    .sort((a, b) => (a.miles ?? 0) - (b.miles ?? 0));
  playerLayer.clearLayers();
  list.forEach((p) => L.marker([p.lat, p.lng], { icon: pinIcon(p) }).addTo(playerLayer).bindPopup(`<b>@${esc(p.username)}</b>${p.note ? '<br><i>' + esc(p.note) + '</i>' : ''}<br>${esc(p.city || '')}${p.deck ? '<br>Plays: ' + esc(p.deck) : ''}`));
  const tile = (p) => `<div class="card">
    <div class="name who">${avatarHtml(p, 'lg')} @${esc(p.username)}</div>
    <div class="meta">${esc(p.city || 'Unknown area')}${p.miles != null ? ' · about ' + p.miles.toFixed(0) + ' mi away' : ''}</div>
    ${p.deck ? `<div class="meta">Plays: ${esc(p.deck)}</div>` : ''}
    ${friendIds.includes(p.id) ? `<button class="btn" data-unadd="${p.id}">Remove trader</button>` : `<button class="btn" data-add="${p.id}">Add trader</button>`}
    <button class="btn" data-msg="${p.id}">Message</button>
  </div>`;
  const friends = list.filter((p) => friendIds.includes(p.id));
  $('#friendsTitle').classList.toggle('hidden', !friends.length);
  $('#friendsList').innerHTML = friends.map(tile).join('');
  $('#nearbyList').innerHTML = list.map(tile).join('') || '<p class="status">No players on the map yet. Turn on "Show me on the trader map" in your profile to be the first!</p>';
}
$('#locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Location is not available on this device.');
  navigator.geolocation.getCurrentPosition((p) => {
    myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (meMarker) meMarker.remove();
    meMarker = L.marker([myPos.lat, myPos.lng], { icon: pinIcon(profile || { username: 'You' }, true) }).addTo(map).bindPopup('You are here').openPopup();
    map.setView([myPos.lat, myPos.lng], 9);
    loadMapPlayers();
  }, () => alert('Could not get your location.'));
});

// Note over your own pin
async function saveNote(note) {
  if (!user) return;
  const { data, error } = await sb.from('profiles').update({ note: note || null }).eq('id', user.id).select().single();
  if (error) { alert('Could not save note: ' + error.message); return; }
  profile = data;
  updateHeader();
  fillProfileForm();
  if (meMarker && myPos) { meMarker.setIcon(pinIcon(profile, true)); }
  if (mapReady) loadMapPlayers();
}
$('#noteForm').addEventListener('submit', (e) => { e.preventDefault(); saveNote($('#noteInput').value.trim().slice(0, 50)); });
$('#clearNote').addEventListener('click', () => { $('#noteInput').value = ''; saveNote(''); });

// ---------- Start ----------
setAuthMode(true);
