// Mythic Spell Swap
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
  if (id === 'news') loadNews();
  if (id === 'live') loadLive();
  if (id === 'collection') loadCollection();
  if (id === 'chat') { $('#unreadDot').classList.add('hidden'); loadConvos(); }
  if (id === 'account' && user) loadMyListings();
  window.scrollTo(0, 0);
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
$('#accountTab').addEventListener('click', () => { if (!user) setAuthMode(false); });
$('#heroJoin').addEventListener('click', () => { if (!user) setAuthMode(true); });

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
  const prevId = user?.id;
  user = session?.user || null;
  if (prevId !== user?.id) {
    messages = []; activePartner = null; pendingListing = null;
    $('#convoList').innerHTML = ''; $('#chatMessages').innerHTML = '';
    $('#chatHeader').textContent = 'Pick a conversation';
    $('#myListings').innerHTML = '';
    $('#profileMsg').textContent = ''; $('#avatarMsg').textContent = '';
    if (typeof renderListings === 'function' && listings.length) renderListings();
  }
  if (user) {
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    profile = data;
    $('#accountTab').textContent = profile ? '@' + profile.username : 'Account';
    $('#heroJoin').classList.add('hidden');
    $('#authBox').classList.add('hidden');
    $('#profileBox').classList.remove('hidden');
    fillProfileForm();
    refreshOwnerUi();
    updateHeader();
    subscribeMessages();
    if ($('#account').classList.contains('active')) loadMyListings();
    if ($('#chat').classList.contains('active')) loadConvos();
  } else {
    profile = null;
    $('#accountTab').textContent = 'Sign in';
    $('#heroJoin').classList.remove('hidden');
    $('#authBox').classList.remove('hidden');
    $('#profileBox').classList.add('hidden');
    updateHeader();
    refreshOwnerUi();
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
function renderAvatarPreview() {
  $('#avatarPreview').outerHTML = avatarHtml(profile, 'xl').replace('<span class="avatar xl"', '<span id="avatarPreview" class="avatar xl"');
}
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
    renderAvatarPreview();
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
  }, () => { $('#locMsg').textContent = "Couldn't get your location. We'll use your city instead when you save."; });
});
$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const username = f.username.value.trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) { $('#profileMsg').textContent = 'Username must be 3-24 letters, numbers or underscores.'; return; }
  const upd = { username, city: f.city.value.trim() || null, deck: f.deck.value.trim() || null, note: f.note.value.trim().slice(0, 50) || null, show_on_map: f.show_on_map.checked };
  if (pendingLoc) Object.assign(upd, pendingLoc);
  else if (upd.show_on_map && !profile.lat && upd.city) {
    // No GPS location: place them on the map by their city instead
    try {
      const g = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(upd.city))).json();
      if (g[0]) Object.assign(upd, { lat: fuzz(+g[0].lat), lng: fuzz(+g[0].lon) });
    } catch {}
  }
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
let nextPage = null, shownCount = 0, totalCount = 0;
async function loadMoreCards() {
  if (!nextPage) return;
  const data = await (await fetch(nextPage)).json();
  $('#marketGrid').insertAdjacentHTML('beforeend', (data.data || []).map(cardTile).join(''));
  shownCount += (data.data || []).length;
  $('#marketStatus').textContent = `Showing ${shownCount} of ${totalCount} cards, highest price first`;
  nextPage = data.has_more ? data.next_page : null;
  $('#loadMore').classList.toggle('hidden', !nextPage);
}
async function runSearch(q) {
  $('#loadMore').classList.add('hidden');
  const status = $('#marketStatus');
  const grid = $('#marketGrid');
  status.textContent = 'Loading prices...';
  grid.innerHTML = '';
  try {
    const url = `https://api.scryfall.com/cards/search?order=usd&dir=desc&unique=cards&q=${encodeURIComponent(q + ' game:paper')}`;
    const data = await (await fetch(url)).json();
    if (!data.data) { status.textContent = 'No cards found. Try another search.'; return; }
    const cards = data.data;
    status.textContent = `Showing ${cards.length} of ${data.total_cards} cards, highest price first`;
    grid.innerHTML = cards.map(cardTile).join('');
    nextPage = data.has_more ? data.next_page : null; shownCount = cards.length; totalCount = data.total_cards;
    $('#loadMore').classList.toggle('hidden', !nextPage);
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
    <button class="btn" data-quick="${esc(c.name)}" data-id="${c.id}" data-usd="${c.prices?.usd || ''}">List this card</button>
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
  lookupCard(b.dataset.quick, b.dataset.id);
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
    <div class="meta who link" data-profile="${l.user_id}">${avatarHtml(l.profiles)} @${esc(seller)}${l.city ? ' · ' + esc(l.city) : ''}</div>
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
  $('#listings').innerHTML = shown.map((l) => listingCard(l, false)).join('') || (listings.length ? '<p class="status">No listings match your filters.</p>' : '<p class="status">No listings yet. Be the first to post one!</p>');
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
function editDist(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Typo fallback: try shorter starts of the name and pick the closest card name
async function guessName(q) {
  for (let n = q.length - 1; n >= 3; n--) {
    try {
      const r = await (await fetch('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(q.slice(0, n)))).json();
      if (r.data && r.data.length) return r.data.reduce((best, x) => (editDist(x, q) < editDist(best, q) ? x : best));
    } catch {}
  }
  return null;
}
async function lookupCard(q, id) {
  if (!q && !id) return;
  $('#cardFound').textContent = 'Finding card...';
  try {
    let c = await (await fetch(id ? 'https://api.scryfall.com/cards/' + id : 'https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(q))).json();
    if (c.object !== 'card' && !id) {
      const g = await guessName(q);
      if (g) c = await (await fetch('https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(g))).json();
    }
    if (c.object !== 'card') { foundCard = null; $('#cardFound').textContent = 'Card not found. Check the spelling.'; return; }
    const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || '';
    foundCard = { name: c.name, id: c.id, image: img, usd: c.prices?.usd };
    const fixed = q && c.name.toLowerCase() !== q.toLowerCase() ? '<br><i>Did you mean this card?</i>' : '';
    $('#cardFound').innerHTML = `${img ? `<img src="${img}" alt="">` : ''}<div><b>${esc(c.name)}</b><br>${esc(c.set_name)}${c.prices?.usd ? '<br>Market price: $' + c.prices.usd : ''}${fixed}</div>`;
    $('#cardSearch').value = c.name;
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
    del.disabled = true; del.textContent = 'Taking down...';
    const { data: gone, error } = await sb.from('listings').delete().eq('id', del.dataset.del).select('id');
    if (error || !gone?.length) { alert('Could not take down post' + (error ? ': ' + error.message : '. Please try again.')); del.disabled = false; del.textContent = 'Take down post'; return; }
    listings = listings.filter((l) => String(l.id) !== del.dataset.del);
    renderListings();
    if (user) loadMyListings();
  }
  const msg = e.target.closest('[data-msg]');
  if (msg) {
    closeModal();
    if (!requireLogin('Sign in to message players.')) return;
    startChat(msg.dataset.msg, msg.dataset.card ? `Hi! Is your ${msg.dataset.card} still available?` : '', msg.dataset.listing || null);
  }
  const add = e.target.closest('[data-add]');
  if (add) {
    if (!requireLogin('Sign in to add friends.')) return;
    closeModalIfNot(add);
    await sb.from('friends').insert({ friend_id: add.dataset.add });
    if (mapReady) loadMapPlayers();
    if (openProfileId) openProfile(openProfileId);
  }
  const rm = e.target.closest('[data-unadd]');
  if (rm) {
    await sb.from('friends').delete().eq('user_id', user.id).eq('friend_id', rm.dataset.unadd);
    if (mapReady) loadMapPlayers();
    if (openProfileId) openProfile(openProfileId);
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
let map, playerLayer, meMarker, storeLayer, storeTimer, hiddenLayer;
let myPos = null;
function initMap() {
  if (mapReady) { setTimeout(() => map.invalidateSize(), 100); loadMapPlayers(); return; }
  mapReady = true;
  map = L.map('mapView', { worldCopyJump: true, minZoom: 2 }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  playerLayer = L.layerGroup().addTo(map);
  storeLayer = L.layerGroup().addTo(map);
  hiddenLayer = L.layerGroup().addTo(map);
  map.on('moveend', drawHidden);
  map.on('moveend', () => { clearTimeout(storeTimer); storeTimer = setTimeout(loadStores, 700); });
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
  const { data: players } = await sb.from('profiles').select('id, username, city, deck, lat, lng, avatar_url, note').eq('show_on_map', true).not('lat', 'is', null).limit(5000);
  let friendIds = [];
  if (user) {
    const { data: fr } = await sb.from('friends').select('friend_id').eq('user_id', user.id);
    friendIds = (fr || []).map((f) => f.friend_id);
  }
  const list = (players || []).filter((p) => !user || p.id !== user.id)
    .map((p) => ({ ...p, miles: myPos ? dist(myPos.lat, myPos.lng, p.lat, p.lng) : null }))
    .sort((a, b) => (a.miles ?? 0) - (b.miles ?? 0));
  playerLayer.clearLayers();
  list.forEach((p) => L.marker([p.lat, p.lng], { icon: pinIcon(p) }).addTo(playerLayer).bindPopup(`<b>@${esc(p.username)}</b>${p.note ? '<br><i>' + esc(p.note) + '</i>' : ''}<br>${esc(p.city || '')}${p.deck ? '<br>Plays: ' + esc(p.deck) : ''}<br><a href="#" data-profile="${p.id}">View profile</a>`));
  // Show your own saved spot too (unless "Find players near me" already placed you)
  if (user && profile?.show_on_map && profile.lat != null && !myPos) {
    L.marker([profile.lat, profile.lng], { icon: pinIcon(profile, true) }).addTo(playerLayer).bindPopup('This is you' + (profile.note ? '<br><i>' + esc(profile.note) + '</i>' : ''));
  }
  const tile = (p) => `<div class="card">
    <div class="name who link" data-profile="${p.id}">${avatarHtml(p, 'lg')} @${esc(p.username)}</div>
    <div class="meta">${esc(p.city || 'Unknown area')}${p.miles != null ? ' · about ' + p.miles.toFixed(0) + ' mi away' : ''}</div>
    ${p.deck ? `<div class="meta">Plays: ${esc(p.deck)}</div>` : ''}
    ${friendIds.includes(p.id) ? `<button class="btn" data-unadd="${p.id}">Remove friend</button>` : `<button class="btn primary" data-add="${p.id}">+ Add friend</button>`}
    <button class="btn" data-msg="${p.id}">Message</button>
  </div>`;
  const friends = list.filter((p) => friendIds.includes(p.id));
  $('#friendsTitle').classList.toggle('hidden', !friends.length);
  $('#friendsList').innerHTML = friends.map(tile).join('');
  $('#nearbyList').innerHTML = list.map(tile).join('') || '<p class="status">No players on the map yet. Turn on "Show me on the trader map" in your profile to be the first!</p>';
}
$('#worldBtn')?.addEventListener('click', () => { if (map) map.setView([20, 0], 2); });
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
  $('#noteInput').placeholder = note ? 'Note posted!' : 'Add a note over your pin (50 characters max)';
  if (note) { const b = $('#noteForm button[type=submit]'); b.textContent = 'Posted!'; setTimeout(() => (b.textContent = 'Post note'), 2000); }
  if (meMarker && myPos) { meMarker.setIcon(pinIcon(profile, true)); }
  if (mapReady) loadMapPlayers();
}
$('#noteForm').addEventListener('submit', (e) => { e.preventDefault(); saveNote($('#noteInput').value.trim().slice(0, 50)); });
$('#clearNote').addEventListener('click', () => { $('#noteInput').value = ''; saveNote(''); });

$('#loadMore').addEventListener('click', loadMoreCards);

// ---------- Start ----------
setAuthMode(true);


// ---------- Modal ----------
let openProfileId = null;
function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; openProfileId = null; gameOn = false; }
$('#modalX').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- Public profile page ----------
const isOwnerAcct = () => profile?.username === 'Young_mav_hallow';
function badgesHtml(egg) {
  if (!egg) return '';
  const b = [];
  if (egg.founder_no) b.push(`<span class="pbadge founder">&#9733; Founder #${egg.founder_no}</span>`);
  if (egg.rare_card) b.push(`<span class="pbadge rare">1 of 1: ${esc(egg.rare_card.name)}</span>`);
  if (egg.game_best) b.push(`<span class="pbadge game">Guess the card best: ${egg.game_best}</span>`);
  return b.length ? `<div class="pbadges">${b.join('')}</div>` : '';
}
async function openProfile(id) {
  openProfileId = id;
  if ($('#modal').classList.contains('hidden')) openModal('<p class="status">Loading profile...</p>');
  const [{ data: p }, { data: counts }, { data: egg }, { data: lst }] = await Promise.all([
    sb.from('profiles').select('id, username, city, deck, note, avatar_url').eq('id', id).maybeSingle(),
    sb.rpc('follow_counts', { uid: id }),
    sb.from('easter_eggs').select('*').eq('user_id', id).maybeSingle(),
    sb.from('listings').select('*, profiles(username, city, avatar_url)').eq('user_id', id).order('created_at', { ascending: false }).limit(60),
  ]);
  const { data: finds } = await sb.from('hidden_finds').select('spot, card, found_at').eq('user_id', id).order('found_at');
  if (openProfileId !== id) return;
  if (!p) { $('#modalBody').innerHTML = '<p class="status">Profile not found.</p>'; return; }
  const c = (counts && counts[0]) || { followers: 0, following: 0 };
  let following = false;
  if (user && user.id !== id) {
    const { data: fr } = await sb.from('friends').select('friend_id').eq('user_id', user.id).eq('friend_id', id);
    following = !!(fr && fr.length);
  }
  const listingsAll = lst || [];
  const decks = listingsAll.filter((l) => l.category === 'deck');
  const other = listingsAll.filter((l) => l.category !== 'deck');
  const me = user && user.id === id;
  $('#modalBody').innerHTML = `<div class="pview">
    <div class="phead">${avatarHtml(p, 'xl')}
      <div><h2>@${esc(p.username)}</h2>
      ${p.city ? `<div class="meta">${esc(p.city)}</div>` : ''}
      ${p.note ? `<div class="pnote">"${esc(p.note)}"</div>` : ''}</div></div>
    ${badgesHtml(egg)}${(finds || []).some((f) => f.spot === 'lotus') ? '<div class="pbadges"><span class="pbadge lotus">Foil Black Lotus</span></div>' : ''}
    ${p.username === 'Young_mav_hallow' ? `<div class="egg-wrap pmenu"><button class="btn icon" data-pmenu aria-label="Menu" title="Menu">&#9776;</button>
      <div class="pop hidden pdots"><button class="btn icon" data-pdots aria-label="More" title="More">&#8943;</button></div>
      <div class="pop menu hidden plotus"><div class="small">Secret found</div><button class="btn primary" data-lotus>Claim foil Black Lotus</button></div></div>` : ''}
    <div class="pstats">
      <div><b>${c.followers}</b><span>Followers</span></div>
      <div><b>${c.following}</b><span>Following</span></div>
      <div><b>${listingsAll.length}</b><span>Listings</span></div>
      <div><b>${decks.length + (p.deck ? 1 : 0)}</b><span>Decks</span></div>
    </div>
    <div class="meta">Hidden cards found: <b>${(finds || []).filter((f) => f.spot !== 'lotus').length}/50</b> state capitals</div>
    ${me ? '<p class="small">This is how other players see your profile.</p>' : `<div class="row">
      ${following ? `<button class="btn" data-unadd="${p.id}">Remove friend</button>` : `<button class="btn primary" data-add="${p.id}">+ Add friend</button>`}
      <button class="btn" data-msg="${p.id}">Message</button></div>`}
    <h3>Decks</h3>
    ${p.deck ? `<div class="card main-deck"><div class="meta">Main deck / commander</div><div class="name">${esc(p.deck)}</div></div>` : ''}
    ${decks.length ? `<div class="grid">${decks.map((l) => listingCard(l)).join('')}</div>` : (p.deck ? '' : '<p class="status">No decks yet.</p>')}
    ${egg?.rare_card ? `<h3>One-of-a-kind card</h3>${rareCardHtml(egg.rare_card)}` : ''}
    ${finds && finds.length ? `<h3>Hidden card collection</h3><div class="collection">${finds.map((f) => `<div class="coll-item ${f.spot === 'lotus' ? 'foil' : ''}"><img src="${esc(f.card.image)}" alt="${esc(f.card.name)}" loading="lazy"><div class="meta">${esc(f.card.name)}${f.card.where ? '<br>' + esc(f.card.where) : ''}</div></div>`).join('')}</div>` : ''}
    <h3>Listings</h3>
    ${other.length ? `<div class="grid">${other.map((l) => listingCard(l)).join('')}</div>` : '<p class="status">No listings yet.</p>'}
  </div>`;
}
$('#viewMyProfile').addEventListener('click', () => { if (user) openProfile(user.id); });
document.addEventListener('click', (e) => {
  const pr = e.target.closest('[data-profile]');
  if (pr) { e.preventDefault(); openProfile(pr.dataset.profile); }
});

// ---------- News ----------
function refreshOwnerUi() { $('#newsForm').classList.toggle('hidden', !isOwnerAcct()); if ($('#news').classList.contains('active')) loadNews(); }
async function loadNews() {
  const { data, error } = await sb.from('news').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) { $('#newsList').innerHTML = '<p class="status">Could not load news.</p>'; return; }
  $('#newsList').innerHTML = (data || []).map((n) => `<article class="card news-item">
    <div class="name">${esc(n.title)}</div>
    ${n.body ? `<div>${esc(n.body).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="meta">${new Date(n.created_at).toLocaleDateString()} · ${ago(n.created_at)}</div>
    ${isOwnerAcct() ? `<button class="btn danger" data-news-del="${n.id}">Delete</button>` : ''}
  </article>`).join('') || '<p class="status">No news yet. Check back soon!</p>';
}
$('#newsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  $('#newsMsg').textContent = 'Posting...';
  const { error } = await sb.from('news').insert({ title: d.title.trim(), body: (d.body || '').trim() || null });
  if (error) { $('#newsMsg').textContent = 'Could not post: ' + error.message; return; }
  e.target.reset(); $('#newsMsg').textContent = 'Posted!';
  loadNews();
});
document.addEventListener('click', async (e) => {
  const nd = e.target.closest('[data-news-del]');
  if (nd && confirm('Delete this news post?')) { await sb.from('news').delete().eq('id', nd.dataset.newsDel); loadNews(); }
});

// ---------- Secret menu (three lines -> three dots -> Easter eggs) ----------
$('#newsMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#dotsPop').classList.toggle('hidden'); $('#eggMenu').classList.add('hidden'); });
$('#dotsBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#eggMenu').classList.toggle('hidden'); $('#dotsPop').classList.add('hidden'); });
document.addEventListener('click', (e) => {
  if (!e.target.closest('.egg-wrap')) { $('#dotsPop').classList.add('hidden'); $('#eggMenu').classList.add('hidden'); }
  const egg = e.target.closest('[data-egg]');
  if (!egg) return;
  $('#eggMenu').classList.add('hidden');
  if (egg.dataset.egg === 'founder') claimFounder();
  if (egg.dataset.egg === 'rare') claimRare();
  if (egg.dataset.egg === 'game') startGame();
});
async function myEgg() {
  if (!user) return null;
  const { data } = await sb.from('easter_eggs').select('*').eq('user_id', user.id).maybeSingle();
  return data;
}
async function claimFounder() {
  if (!user) { openModal('<h2>&#9733; Founder badge</h2><p>You found a secret! Sign in or create an account to claim your Founder badge.</p><button class="btn primary" data-goto-account>Sign in</button>'); return; }
  openModal('<p class="status">Checking...</p>');
  const { data: n, error } = await sb.rpc('claim_founder');
  if (error) { $('#modalBody').innerHTML = '<p class="status">Something went wrong. Try again.</p>'; return; }
  $('#modalBody').innerHTML = n
    ? `<div class="egg-reveal"><div class="big-badge">&#9733;</div><h2>Founder #${n}</h2><p>You're one of the first 100 players to find the secret menu. This badge now shows on your profile forever.</p></div>`
    : '<div class="egg-reveal"><h2>So close!</h2><p>All 100 Founder badges have already been claimed. Try the other secrets in the menu.</p></div>';
}
function rareCardHtml(rc) {
  return `<div class="rare-card" style="--hue:${Number(rc.hue) || 0}">
    <img src="${esc(rc.image)}" alt="${esc(rc.name)}">
    <div class="rare-tag">1 of 1</div></div>
    <div class="meta">${esc(rc.name)} · ${esc(rc.set_name || '')}</div>`;
}
async function claimRare() {
  if (!user) { openModal('<h2>One-of-a-kind card</h2><p>You found a secret! Sign in or create an account to unlock a card nobody else on Mythic Spell Swap can ever get.</p><button class="btn primary" data-goto-account>Sign in</button>'); return; }
  openModal('<p class="status">Opening your card...</p>');
  const mine = await myEgg();
  if (mine?.rare_card) { $('#modalBody').innerHTML = `<div class="egg-reveal"><h2>Your one-of-a-kind card</h2>${rareCardHtml(mine.rare_card)}<p class="small">Only you have this card on Mythic Spell Swap. It shows on your profile.</p></div>`; return; }
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/random?q=' + encodeURIComponent('(rarity:mythic or rarity:rare) game:paper -is:funny'));
      const c = await r.json();
      const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal;
      if (!img) continue;
      const card = { id: c.id, name: c.name, set_name: c.set_name, image: img, hue: Math.floor(Math.random() * 360) };
      const { data, error } = await sb.rpc('claim_rare_card', { card });
      if (error) break;
      if (data) { $('#modalBody').innerHTML = `<div class="egg-reveal"><h2>You unlocked a 1 of 1!</h2>${rareCardHtml(data)}<p class="small">Nobody else on Mythic Spell Swap can ever get this card. It now shows on your profile.</p></div>`; return; }
    } catch (err) { /* try again */ }
  }
  $('#modalBody').innerHTML = '<p class="status">Could not open a card right now. Try again in a moment.</p>';
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-goto-account]')) { closeModal(); setAuthMode(false); showTab('account'); } });

// Mini-game: guess the card from its art
let gameOn = false, gameScore = 0;
async function randomCard() {
  const r = await fetch('https://api.scryfall.com/cards/random?q=' + encodeURIComponent('game:paper -is:funny -t:basic has:art'));
  return r.json();
}
function startGame() { gameOn = true; gameScore = 0; openModal('<p class="status">Shuffling...</p>'); gameRound(); }
async function gameRound() {
  try {
    const cards = await Promise.all([randomCard(), randomCard(), randomCard(), randomCard()]);
    if (!gameOn) return;
    const ans = cards[0];
    const art = ans.image_uris?.art_crop || ans.card_faces?.[0]?.image_uris?.art_crop;
    const names = [...new Set(cards.map((c) => c.name))];
    if (!art || names.length < 4) return gameRound();
    names.sort(() => Math.random() - 0.5);
    $('#modalBody').innerHTML = `<div class="game">
      <h2>Guess the card</h2><div class="meta">Score: ${gameScore}</div>
      <img class="game-art" src="${esc(art)}" alt="Card art">
      <div class="game-opts">${names.map((n) => `<button class="btn" data-guess="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>`;
    $('#modalBody').dataset.answer = ans.name;
    $('#modalBody').dataset.answerImg = ans.image_uris?.normal || ans.card_faces?.[0]?.image_uris?.normal || '';
  } catch (err) { $('#modalBody').innerHTML = '<p class="status">Could not load cards. Try again in a moment.</p>'; }
}
document.addEventListener('click', async (e) => {
  const g = e.target.closest('[data-guess]');
  if (!g || !gameOn) return;
  const answer = $('#modalBody').dataset.answer;
  $$('[data-guess]').forEach((b) => { b.disabled = true; if (b.dataset.guess === answer) b.classList.add('right'); });
  if (g.dataset.guess === answer) { gameScore++; setTimeout(() => gameOn && gameRound(), 700); return; }
  g.classList.add('wrong');
  let best = null;
  if (user) { const { data } = await sb.rpc('save_game_score', { score: gameScore }); best = data; }
  const { data: top } = await sb.from('easter_eggs').select('user_id, game_best').gt('game_best', 0).order('game_best', { ascending: false }).limit(5);
  await getProfiles((top || []).map((t) => t.user_id));
  setTimeout(() => {
    if (!gameOn) return;
    $('#modalBody').innerHTML = `<div class="game egg-reveal"><h2>Game over</h2>
      <p>It was <b>${esc(answer)}</b>.</p>
      ${$('#modalBody').dataset.answerImg ? `<img class="game-card" src="${esc($('#modalBody').dataset.answerImg)}" alt="">` : ''}
      <p>Your score: <b>${gameScore}</b>${best != null ? ` · Your best: <b>${best}</b>` : ' · Sign in to save your best score'}</p>
      ${top && top.length ? `<h3>Top players</h3><ol class="leader">${top.map((t) => `<li>@${esc(profilesById[t.user_id]?.username || 'player')} - ${t.game_best}</li>`).join('')}</ol>` : ''}
      <button class="btn primary" id="playAgain">Play again</button></div>`;
    $('#playAgain').addEventListener('click', startGame);
  }, 900);
});

// ---------- Game stores on the map (OpenStreetMap) ----------
const storeCache = {};
const storeIcon = L.divIcon({ className: 'store-pin', html: '<div class="store-dot">&#9830;</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
async function loadStores() {
  if (!map || !storeLayer) return;
  if (!$('#storesToggle').checked) { storeLayer.clearLayers(); return; }
  if (map.getZoom() < 9) { storeLayer.clearLayers(); $('#storeMsg').firstChild.textContent = 'Zoom in on any city to see game stores there. Store data from OpenStreetMap. Official Wizards stores: '; return; }
  const b = map.getBounds();
  const r = (v) => Math.round(v * 10) / 10;
  const key = [r(b.getSouth()), r(b.getWest()), r(b.getNorth()), r(b.getEast())].join(',');
  let els = storeCache[key];
  if (!els) {
    $('#storeMsg').firstChild.textContent = 'Finding game stores... ';
    const q = `[out:json][timeout:12];(nwr["shop"="games"](${key});nwr["shop"~"collector|hobby|comics"]["name"~"[Gg]ame|[Cc]ard|[Mm]agic|MTG|[Cc]omic",i](${key}););out center 400;`;
    const mirrors = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];
    for (const m of mirrors) {
      try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(m, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal });
        clearTimeout(tm);
        if (!res.ok) throw new Error(res.status);
        els = (await res.json()).elements || [];
        storeCache[key] = els;
        break;
      } catch (err) { await new Promise((ok) => setTimeout(ok, 800)); }
    }
    if (!els) { $('#storeMsg').firstChild.textContent = 'Could not load game stores right now, move the map to try again. '; return; }
  }
  storeLayer.clearLayers();
  els.forEach((s) => {
    const lat = s.lat ?? s.center?.lat, lng = s.lon ?? s.center?.lon;
    if (lat == null) return;
    const t = s.tags || {};
    const addr = [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ');
    const site = t.website || t['contact:website'];
    L.marker([lat, lng], { icon: storeIcon }).addTo(storeLayer).bindPopup(`<b>${esc(t.name || 'Game store')}</b>${addr ? '<br>' + esc(addr) : ''}${t.opening_hours ? '<br>' + esc(t.opening_hours) : ''}${site ? `<br><a href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ''}<br><a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Directions</a>`);
  });
  $('#storeMsg').firstChild.textContent = `${els.length} game store${els.length === 1 ? '' : 's'} in this area. Store data from OpenStreetMap. Official Wizards stores: `;
}
$('#storesToggle').addEventListener('change', loadStores);

// ---------- Find friends by username ----------
function closeModalIfNot() {}
$('#findForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#findInput').value.trim().replace(/[%,()*]/g, '');
  if (!q) { $('#findList').innerHTML = ''; return; }
  $('#findList').innerHTML = '<p class="status">Searching...</p>';
  const { data } = await sb.from('profiles').select('id, username, city, deck, avatar_url').ilike('username', '%' + q + '%').limit(24);
  let friendIds = [];
  if (user) { const { data: fr } = await sb.from('friends').select('friend_id').eq('user_id', user.id); friendIds = (fr || []).map((f) => f.friend_id); }
  const rows = (data || []).filter((p) => !user || p.id !== user.id);
  $('#findList').innerHTML = rows.map((p) => `<div class="card">
    <div class="name who link" data-profile="${p.id}">${avatarHtml(p, 'lg')} @${esc(p.username)}</div>
    <div class="meta">${esc(p.city || 'Unknown area')}</div>
    ${friendIds.includes(p.id) ? `<button class="btn" data-unadd="${p.id}">Remove friend</button>` : `<button class="btn primary" data-add="${p.id}">+ Add friend</button>`}
    <button class="btn" data-profile="${p.id}">View profile</button>
  </div>`).join('') || '<p class="status">No players found with that name.</p>';
});
// refresh search results after adding/removing a friend
document.addEventListener('click', (e) => {
  if (e.target.closest('#findList [data-add], #findList [data-unadd]')) setTimeout(() => $('#findForm').requestSubmit(), 600);
});

// ---------- Hidden cards: foil Black Lotus on the owner's profile + one in every state capital ----------
const CAPITALS = [{"s": "AL", "city": "Montgomery", "lat": 32.3777, "lng": -86.3006, "card": "Mox Pearl"}, {"s": "AK", "city": "Juneau", "lat": 58.3019, "lng": -134.4197, "card": "Tundra"}, {"s": "AZ", "city": "Phoenix", "lat": 33.4484, "lng": -112.074, "card": "Arclight Phoenix"}, {"s": "AR", "city": "Little Rock", "lat": 34.7465, "lng": -92.2896, "card": "Mox Jet"}, {"s": "CA", "city": "Sacramento", "lat": 38.5767, "lng": -121.4934, "card": "The One Ring"}, {"s": "CO", "city": "Denver", "lat": 39.7392, "lng": -104.9903, "card": "Plateau"}, {"s": "CT", "city": "Hartford", "lat": 41.7637, "lng": -72.6851, "card": "Ancestral Recall"}, {"s": "DE", "city": "Dover", "lat": 39.1582, "lng": -75.5244, "card": "Sol Ring"}, {"s": "FL", "city": "Tallahassee", "lat": 30.4383, "lng": -84.2807, "card": "Savannah"}, {"s": "GA", "city": "Atlanta", "lat": 33.749, "lng": -84.388, "card": "Mox Ruby"}, {"s": "HI", "city": "Honolulu", "lat": 21.3069, "lng": -157.8583, "card": "Tropical Island"}, {"s": "ID", "city": "Boise", "lat": 43.615, "lng": -116.2023, "card": "Gaea's Cradle"}, {"s": "IL", "city": "Springfield", "lat": 39.7817, "lng": -89.6501, "card": "Time Walk"}, {"s": "IN", "city": "Indianapolis", "lat": 39.7684, "lng": -86.1581, "card": "Ragavan, Nimble Pilferer"}, {"s": "IA", "city": "Des Moines", "lat": 41.5868, "lng": -93.625, "card": "Craterhoof Behemoth"}, {"s": "KS", "city": "Topeka", "lat": 39.0473, "lng": -95.6752, "card": "Sylvan Library"}, {"s": "KY", "city": "Frankfort", "lat": 38.2009, "lng": -84.8733, "card": "Mox Emerald"}, {"s": "LA", "city": "Baton Rouge", "lat": 30.4515, "lng": -91.1871, "card": "Bayou"}, {"s": "ME", "city": "Augusta", "lat": 44.3106, "lng": -69.7795, "card": "Lord of Atlantis"}, {"s": "MD", "city": "Annapolis", "lat": 38.9784, "lng": -76.4922, "card": "Underground Sea"}, {"s": "MA", "city": "Boston", "lat": 42.3601, "lng": -71.0589, "card": "Jace, the Mind Sculptor"}, {"s": "MI", "city": "Lansing", "lat": 42.7325, "lng": -84.5555, "card": "Mishra's Workshop"}, {"s": "MN", "city": "Saint Paul", "lat": 44.9537, "lng": -93.09, "card": "Force of Will"}, {"s": "MS", "city": "Jackson", "lat": 32.2988, "lng": -90.1848, "card": "Dark Ritual"}, {"s": "MO", "city": "Jefferson City", "lat": 38.5767, "lng": -92.1735, "card": "Demonic Tutor"}, {"s": "MT", "city": "Helena", "lat": 46.5891, "lng": -112.0391, "card": "Taiga"}, {"s": "NE", "city": "Lincoln", "lat": 40.8136, "lng": -96.7026, "card": "Birds of Paradise"}, {"s": "NV", "city": "Carson City", "lat": 39.1638, "lng": -119.7674, "card": "Lion's Eye Diamond"}, {"s": "NH", "city": "Concord", "lat": 43.2081, "lng": -71.5376, "card": "Serra Angel"}, {"s": "NJ", "city": "Trenton", "lat": 40.2206, "lng": -74.7597, "card": "Mana Crypt"}, {"s": "NM", "city": "Santa Fe", "lat": 35.687, "lng": -105.9378, "card": "Badlands"}, {"s": "NY", "city": "Albany", "lat": 42.6526, "lng": -73.7562, "card": "Library of Alexandria"}, {"s": "NC", "city": "Raleigh", "lat": 35.7796, "lng": -78.6382, "card": "Volcanic Island"}, {"s": "ND", "city": "Bismarck", "lat": 46.8083, "lng": -100.7837, "card": "Wrath of God"}, {"s": "OH", "city": "Columbus", "lat": 39.9612, "lng": -82.9988, "card": "Timetwister"}, {"s": "OK", "city": "Oklahoma City", "lat": 35.4676, "lng": -97.5164, "card": "Bazaar of Baghdad"}, {"s": "OR", "city": "Salem", "lat": 44.9429, "lng": -123.0351, "card": "Mox Sapphire"}, {"s": "PA", "city": "Harrisburg", "lat": 40.2732, "lng": -76.8867, "card": "Necropotence"}, {"s": "RI", "city": "Providence", "lat": 41.824, "lng": -71.4128, "card": "Counterspell"}, {"s": "SC", "city": "Columbia", "lat": 34.0007, "lng": -81.0348, "card": "Scrubland"}, {"s": "SD", "city": "Pierre", "lat": 44.3683, "lng": -100.351, "card": "Grim Monolith"}, {"s": "TN", "city": "Nashville", "lat": 36.1627, "lng": -86.7816, "card": "Rhystic Study"}, {"s": "TX", "city": "Austin", "lat": 30.2672, "lng": -97.7431, "card": "Sheoldred, the Apocalypse"}, {"s": "UT", "city": "Salt Lake City", "lat": 40.7608, "lng": -111.891, "card": "Mox Diamond"}, {"s": "VT", "city": "Montpelier", "lat": 44.2601, "lng": -72.5754, "card": "Shivan Dragon"}, {"s": "VA", "city": "Richmond", "lat": 37.5407, "lng": -77.436, "card": "The Tabernacle at Pendrell Vale"}, {"s": "WA", "city": "Olympia", "lat": 47.0379, "lng": -122.9007, "card": "Cyclonic Rift"}, {"s": "WV", "city": "Charleston", "lat": 38.3498, "lng": -81.6326, "card": "Chrome Mox"}, {"s": "WI", "city": "Madison", "lat": 43.0731, "lng": -89.4012, "card": "Dockside Extortionist"}, {"s": "WY", "city": "Cheyenne", "lat": 41.14, "lng": -104.8202, "card": "Lightning Bolt"}];
let myFinds = new Set();
async function loadMyFinds() {
  myFinds = new Set();
  if (!user) return;
  const { data } = await sb.from('hidden_finds').select('spot').eq('user_id', user.id);
  (data || []).forEach((f) => myFinds.add(f.spot));
}
const cardImgCache = {};
async function cardImage(name) {
  // Direct Scryfall image link: no lookup call needed, so the claim never fails on a slow or rate-limited request
  return { img: 'https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name) + '&format=image&version=normal', set_name: '' };
}
async function claimHidden(spot, name, where, foil) {
  if (!user) { openModal(`<div class="egg-reveal"><h2>You found a hidden card!</h2><p>Sign in or create an account to claim it.</p><button class="btn primary" data-goto-account>Sign in</button></div>`); return; }
  openModal('<p class="status">Claiming...</p>');
  try {
    const { img, set_name } = await cardImage(name);
    let res = await sb.rpc('claim_hidden', { spot, card: { name, image: img, set_name, where, foil: !!foil } });
    if (res.error) { await new Promise((ok) => setTimeout(ok, 1000)); res = await sb.rpc('claim_hidden', { spot, card: { name, image: img, set_name, where, foil: !!foil } }); }
    if (res.error) throw res.error;
    const data = res.data;
    myFinds.add(spot);
    drawHidden();
    $('#modalBody').innerHTML = `<div class="egg-reveal"><h2>${foil ? 'Foil ' : ''}${esc(data.name)}</h2>
      <div class="rare-card ${foil ? 'lotus-foil' : ''}" style="--hue:${foil ? 280 : 45}"><img src="${esc(data.image)}" alt="${esc(data.name)}"><div class="rare-tag">${foil ? 'FOIL' : esc(spot)}</div></div>
      <p>${foil ? 'You found the secret foil Black Lotus!' : `Hidden card found in ${esc(where)}!`} It's now in your collection on your profile.</p>
      ${foil ? '' : `<p class="small">You've found ${[...myFinds].filter((s) => s !== 'lotus').length} of 50 state capital cards.</p>`}</div>`;
  } catch (err) { $('#modalBody').innerHTML = '<p class="status">Could not claim right now. Try again in a moment.</p>'; }
}
const hiddenIcon = (found) => L.divIcon({ className: 'hidden-pin', html: `<div class="hidden-card ${found ? 'found' : ''}">${found ? '&#10003;' : '?'}</div>`, iconSize: [30, 42], iconAnchor: [15, 21] });
function drawHidden() {
  if (!map || !hiddenLayer) return;
  hiddenLayer.clearLayers();
  if (map.getZoom() < 6) return;
  const b = map.getBounds();
  CAPITALS.forEach((c) => {
    // check the pin's copies across the wrapped world so Alaska, Hawaii and every state show however the map was panned
    [0, 360, -360, 720, -720].forEach((shift) => {
      const lng = c.lng + shift;
      if (!b.contains([c.lat, lng])) return;
      L.marker([c.lat, lng], { icon: hiddenIcon(myFinds.has(c.s)) }).addTo(hiddenLayer)
        .on('click', () => claimHidden(c.s, c.card, c.city + ', ' + c.s, false));
    });
  });
}
document.addEventListener('click', (e) => {
  const m = e.target.closest('[data-pmenu]');
  if (m) { e.stopPropagation(); const w = m.closest('.pmenu'); w.querySelector('.pdots').classList.toggle('hidden'); w.querySelector('.plotus').classList.add('hidden'); return; }
  const d = e.target.closest('[data-pdots]');
  if (d) { e.stopPropagation(); const w = d.closest('.pmenu'); w.querySelector('.plotus').classList.toggle('hidden'); w.querySelector('.pdots').classList.add('hidden'); return; }
  if (e.target.closest('[data-lotus]')) claimHidden('lotus', 'Black Lotus', 'Secret menu', true);
});
sb.auth.onAuthStateChange(() => { setTimeout(async () => { await loadMyFinds(); drawHidden(); }, 50); });

// ---------- My Cards: online collection + card scanner ----------
let coll = [];
let collCard = null;
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
function cardImg(c) { return c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || ''; }
async function loadCollection() {
  $('#collGate').classList.toggle('hidden', !!user);
  $('#collWrap').classList.toggle('hidden', !user);
  if (!user) { coll = []; $('#collTotal').textContent = ''; return; }
  const { data, error } = await sb.from('collection').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  if (error) { $('#collList').innerHTML = '<p class="status">Could not load your collection.</p>'; return; }
  coll = data || [];
  renderCollection();
}
function renderCollection() {
  const f = $('#collFilter').value.toLowerCase();
  const sort = $('#collSort').value;
  let rows = coll.filter((r) => !f || (r.name + ' ' + (r.set_name || '')).toLowerCase().includes(f));
  if (sort === 'value') rows = [...rows].sort((a, b) => (b.price_usd || 0) * b.quantity - (a.price_usd || 0) * a.quantity);
  if (sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const count = coll.reduce((s, r) => s + r.quantity, 0);
  const value = coll.reduce((s, r) => s + (Number(r.price_usd) || 0) * r.quantity, 0);
  $('#collTotal').innerHTML = `<b>${count.toLocaleString()}</b> cards · <b>${money(value)}</b>`;
  $('#collList').innerHTML = rows.map((r) => `<div class="card coll-card">
    ${r.image ? `<img class="cover cardimg${r.foil ? ' foil-img' : ''}" loading="lazy" src="${esc(r.image)}" alt="${esc(r.name)}">` : ''}
    <div class="name">${esc(r.name)}${r.foil ? ' <span class="badge">Foil</span>' : ''}</div>
    <div class="meta">${esc(r.set_name || '')} · ${esc(r.condition || '')}</div>
    <div class="meta">${r.price_usd != null ? money(r.price_usd) + ' each · ' + money(r.price_usd * r.quantity) + ' total' : 'No price'}</div>
    <div class="qty"><button class="btn" data-cq="${r.id}" data-d="-1">-</button><b>${r.quantity}</b><button class="btn" data-cq="${r.id}" data-d="1">+</button></div>
    <button class="btn danger" data-crm="${r.id}">Remove</button>
  </div>`).join('') || '<p class="status">No cards yet. Scan a card or type a name to start your collection.</p>';
}
$('#collFilter').addEventListener('input', renderCollection);
$('#collSort').addEventListener('change', renderCollection);
document.addEventListener('click', async (e) => {
  const q = e.target.closest('[data-cq]');
  if (q) {
    const r = coll.find((x) => String(x.id) === q.dataset.cq); if (!r) return;
    const n = r.quantity + Number(q.dataset.d);
    if (n < 1) { const { data: gone } = await sb.from('collection').delete().eq('id', r.id).select('id'); if (!gone?.length) { alert('Could not remove. Please try again.'); return; } coll = coll.filter((x) => x !== r); }
    else { await sb.from('collection').update({ quantity: n }).eq('id', r.id); r.quantity = n; }
    renderCollection();
  }
  const rm = e.target.closest('[data-crm]');
  if (rm) {
    const r = coll.find((x) => String(x.id) === rm.dataset.crm);
    if (!r) return;
    // two-tap confirm right on the button (no popup dialog)
    if (rm.dataset.armed !== '1') { rm.dataset.armed = '1'; rm.textContent = 'Tap again to remove'; setTimeout(() => { if (rm.isConnected) { rm.dataset.armed = ''; rm.textContent = 'Remove'; } }, 4000); return; }
    rm.disabled = true; rm.textContent = 'Removing...';
    const { data: gone, error } = await sb.from('collection').delete().eq('id', r.id).select('id');
    if (error || !gone?.length) { rm.disabled = false; rm.dataset.armed = ''; rm.textContent = 'Remove'; alert('Could not remove' + (error ? ': ' + error.message : '. Please try again.')); return; }
    coll = coll.filter((x) => x !== r);
    renderCollection();
  }
});
// Name autocomplete
let collAcTimer;
$('#collSearch').addEventListener('input', () => {
  clearTimeout(collAcTimer);
  const v = $('#collSearch').value.trim();
  if (v.length < 2) return;
  collAcTimer = setTimeout(async () => {
    try {
      const r = await fetch('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(v));
      const d = await r.json();
      $('#collSuggest').innerHTML = (d.data || []).slice(0, 15).map((n) => `<option value="${esc(n)}">`).join('');
    } catch (err) { /* ignore */ }
  }, 250);
});
async function fuzzyCard(name) {
  const r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name));
  if (!r.ok) return null;
  const c = await r.json();
  return c.object === 'card' ? c : null;
}
$('#collFindForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#collSearch').value.trim(); if (!v) return;
  $('#collFound').innerHTML = '<p class="status">Looking it up...</p>';
  const c = await fuzzyCard(v);
  if (!c) { $('#collFound').innerHTML = '<p class="status">Could not find that card. Check the spelling.</p>'; return; }
  showFound(c);
});
async function showFound(c) {
  collCard = c;
  let prints = [c];
  try {
    const r = await fetch(c.prints_search_uri);
    const d = await r.json();
    if (d.data && d.data.length) prints = d.data.filter((p) => !p.digital).slice(0, 80);
    if (!prints.some((p) => p.id === c.id)) prints.unshift(c);
  } catch (err) { /* keep single print */ }
  collCard._prints = prints;
  $('#collFound').innerHTML = `<div class="found-card">
    <img id="fcImg" src="${esc(cardImg(c))}" alt="${esc(c.name)}">
    <div class="stack">
      <div class="name">${esc(c.name)}</div>
      <label>Printing<select id="fcPrint">${prints.map((p) => `<option value="${p.id}" ${p.id === c.id ? 'selected' : ''}>${esc(p.set_name)} (${esc(p.set.toUpperCase())} #${esc(p.collector_number)})</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="fcFoil"> Foil</label>
      <label>Condition<select id="fcCond"><option>Near Mint</option><option>Lightly Played</option><option>Moderately Played</option><option>Heavily Played</option><option>Damaged</option></select></label>
      <label>Quantity<input id="fcQty" type="number" min="1" max="1000" value="1"></label>
      <div id="fcPrice" class="price"></div>
      <button class="btn primary" id="fcAdd" type="button">Add to collection</button>
      <p id="fcMsg" class="small"></p>
    </div></div>`;
  const upd = () => {
    const p = prints.find((x) => x.id === $('#fcPrint').value) || c;
    $('#fcImg').src = cardImg(p);
    const price = $('#fcFoil').checked ? p.prices?.usd_foil : p.prices?.usd;
    $('#fcPrice').textContent = price ? money(price) + ' each' : 'No price listed';
  };
  $('#fcPrint').addEventListener('change', upd);
  $('#fcFoil').addEventListener('change', upd);
  upd();
  $('#fcAdd').addEventListener('click', addFound);
}
async function addFound() {
  if (!user) { requireLogin('Sign in to save your collection.'); return; }
  const p = collCard._prints.find((x) => x.id === $('#fcPrint').value) || collCard;
  const foil = $('#fcFoil').checked;
  const condition = $('#fcCond').value;
  const qty = Math.max(1, Math.min(1000, parseInt($('#fcQty').value, 10) || 1));
  const price = foil ? p.prices?.usd_foil : p.prices?.usd;
  $('#fcAdd').disabled = true; $('#fcMsg').textContent = 'Adding...';
  const existing = coll.find((r) => r.scryfall_id === p.id && r.foil === foil && r.condition === condition);
  let error;
  if (existing) ({ error } = await sb.from('collection').update({ quantity: existing.quantity + qty, price_usd: price ? Number(price) : existing.price_usd }).eq('id', existing.id));
  else ({ error } = await sb.from('collection').insert({ scryfall_id: p.id, name: p.name, set_name: p.set_name, set_code: p.set, image: cardImg(p), price_usd: price ? Number(price) : null, quantity: qty, foil, condition }));
  $('#fcAdd').disabled = false;
  if (error) { $('#fcMsg').textContent = 'Could not add: ' + error.message; return; }
  $('#fcMsg').textContent = `Added ${qty} x ${p.name} to your collection!`;
  $('#scanStatus').textContent = '';
  loadCollection();
}
// Card scanner: photo -> read the name with OCR -> match it on Scryfall
let tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) tesseractLoading = new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
  return tesseractLoading;
}
function fileToImage(file) {
  return new Promise((ok, fail) => { const img = new Image(); img.onload = () => ok(img); img.onerror = fail; img.src = URL.createObjectURL(file); });
}
function cropCanvas(img, y0, y1, x0 = 0.03, x1 = 0.97) {
  const W = 1400, scale = W / img.width, H = img.height * scale;
  const cv = document.createElement('canvas');
  cv.width = W * (x1 - x0); cv.height = H * (y1 - y0);
  const ctx = cv.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(img, img.width * x0, img.height * y0, img.width * (x1 - x0), img.height * (y1 - y0), 0, 0, cv.width, cv.height);
  return cv;
}
function candidates(text) {
  return text.split('\n').map((l) => l.replace(/[^A-Za-z',\- ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3 && /[A-Za-z]{3}/.test(l))
    .sort((a, b) => b.length - a.length).slice(0, 6);
}
$('#scanInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!user) { requireLogin('Sign in to save your collection.'); return; }
  $('#collFound').innerHTML = '';
  $('#scanStatus').textContent = 'Loading the scanner...';
  try {
    await loadTesseract();
    const img = await fileToImage(file);
    const worker = await Tesseract.createWorker('eng');
    // Try the name bar at the top of the card first, then wider areas in case the photo isn't tightly cropped
    const areas = [[0.02, 0.13], [0.0, 0.25], [0.0, 0.6]];
    for (let i = 0; i < areas.length; i++) {
      $('#scanStatus').textContent = `Reading the card name${i ? ' (try ' + (i + 1) + ')' : ''}...`;
      const { data } = await worker.recognize(cropCanvas(img, areas[i][0], areas[i][1]));
      for (const cand of candidates(data.text)) {
        const c = await fuzzyCard(cand);
        if (c) { await worker.terminate(); $('#scanStatus').textContent = 'Found it! Check the printing, then add it.'; showFound(c); return; }
      }
    }
    await worker.terminate();
    $('#scanStatus').textContent = "Couldn't read that card. Try again with better light and the name in focus, or type the name below.";
  } catch (err) {
    $('#scanStatus').textContent = 'The scanner had a problem. Try again, or type the card name below.';
  }
});
sb.auth.onAuthStateChange(() => { setTimeout(() => { if ($('#collection').classList.contains('active')) loadCollection(); else { coll = []; $('#collList').innerHTML = ''; } }, 60); });

// ---------- Pack opening videos (embedded YouTube / TikTok / Twitch) ----------
const SITE_HOST = location.hostname || 'mythicspellswap.github.io';
function parseVideo(link) {
  let u; try { u = new URL(link.trim().startsWith('http') ? link.trim() : 'https://' + link.trim()); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const ok = (s) => (/^[A-Za-z0-9_-]{2,120}$/.test(s || '') ? s : null);
  if (host === 'youtu.be') { const id = ok(u.pathname.slice(1)); return id && { platform: 'youtube', channel: id }; }
  if (host.endsWith('youtube.com')) {
    const v = ok(u.searchParams.get('v')); if (v) return { platform: 'youtube', channel: v };
    const m = u.pathname.match(/^\/(live|embed|shorts)\/([A-Za-z0-9_-]+)/);
    return m && ok(m[2]) ? { platform: 'youtube', channel: m[2] } : null;
  }
  if (host.endsWith('tiktok.com')) { const m = u.pathname.match(/\/video\/(\d{5,25})/); return m ? { platform: 'tiktok', channel: m[1] } : null; }
  if (host === 'clips.twitch.tv') { const id = ok(u.pathname.split('/')[1]); return id && { platform: 'twitch_clip', channel: id }; }
  if (host.endsWith('twitch.tv')) {
    let m = u.pathname.match(/^\/videos\/(\d+)/); if (m) return { platform: 'twitch_video', channel: m[1] };
    m = u.pathname.match(/\/clip\/([A-Za-z0-9_-]+)/); if (m && ok(m[1])) return { platform: 'twitch_clip', channel: m[1] };
  }
  return null;
}
function embedSrc(s) {
  if (s.platform === 'youtube') return `https://www.youtube.com/embed/${s.channel}`;
  if (s.platform === 'tiktok') return `https://www.tiktok.com/embed/v2/${s.channel}`;
  if (s.platform === 'twitch_video') return `https://player.twitch.tv/?video=${s.channel}&parent=${SITE_HOST}&autoplay=false`;
  if (s.platform === 'twitch_clip') return `https://clips.twitch.tv/embed?clip=${s.channel}&parent=${SITE_HOST}&autoplay=false`;
  if (s.platform === 'twitch') return `https://player.twitch.tv/?channel=${s.channel}&parent=${SITE_HOST}&autoplay=false`;
  return `https://player.kick.com/${s.channel}?autoplay=false`;
}
const PLATFORM_NAME = { youtube: 'YouTube', tiktok: 'TikTok', twitch_video: 'Twitch', twitch_clip: 'Twitch clip', twitch: 'Twitch', kick: 'Kick' };
async function amStreamer() {
  if (!user) return false;
  if (isOwnerAcct()) return true;
  const { data } = await sb.from('streamers').select('user_id').eq('user_id', user.id).maybeSingle();
  return !!data;
}
async function loadLive() {
  const { data: vids } = await sb.from('streams').select('*').order('created_at', { ascending: false }).limit(50);
  const list = vids || [];
  await getProfiles(list.map((s) => s.user_id));
  $('#streamList').innerHTML = list.map((s) => `<div class="card stream-card">
    <div class="stream-frame${s.platform === 'tiktok' ? ' tall' : ''}"><iframe src="${esc(embedSrc(s))}" allowfullscreen allow="encrypted-media; picture-in-picture" loading="lazy" title="${esc(s.title || 'Video')}"></iframe></div>
    <div class="row between"><b>${esc(s.title || 'Pack opening')}</b><span class="meta">${PLATFORM_NAME[s.platform] || ''} · ${ago(s.created_at)}</span></div>
    <div class="meta who link" data-profile="${s.user_id}">${avatarHtml(profilesById[s.user_id])} @${esc(profilesById[s.user_id]?.username || 'player')}</div>
    ${user && (s.user_id === user.id || isOwnerAcct()) ? `<button class="btn danger" data-endstream="${s.id}">Delete video</button>` : ''}
  </div>`).join('') || '<p class="status">No videos yet. Check back soon!</p>';
  const canPost = await amStreamer();
  $('#goLiveBox').classList.toggle('hidden', !canPost);
  $('#streamerAdmin').classList.toggle('hidden', !isOwnerAcct());
  if (isOwnerAcct()) loadStreamers();
}
async function loadStreamers() {
  const { data } = await sb.from('streamers').select('user_id, added_at').order('added_at');
  await getProfiles((data || []).map((s) => s.user_id));
  $('#streamerList').innerHTML = (data || []).map((s) => `<div class="row between"><span>@${esc(profilesById[s.user_id]?.username || 'player')}</span><button class="btn" data-rmstreamer="${s.user_id}">Remove</button></div>`).join('') || '<p class="small">Nobody approved yet. You can always post videos yourself.</p>';
}
$('#goLiveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  const s = parseVideo(d.link || '');
  if (!s) { $('#goLiveMsg').textContent = "That link didn't work. Use a YouTube video, TikTok video, or Twitch video/clip link."; return; }
  $('#goLiveMsg').textContent = 'Posting...';
  const { error } = await sb.from('streams').insert({ title: (d.title || '').trim() || null, platform: s.platform, channel: s.channel });
  if (error) { $('#goLiveMsg').textContent = 'Could not post: ' + error.message; return; }
  e.target.reset();
  await loadLive();
  $('#goLiveMsg').textContent = 'Video posted!';
  setTimeout(() => { $('#goLiveMsg').textContent = ''; }, 5000);
});
$('#addStreamerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#addStreamerInput').value.trim().replace(/^@/, '');
  if (!name) return;
  const { data: p } = await sb.from('profiles').select('id, username').ilike('username', name).maybeSingle();
  if (!p) { $('#streamerMsg').textContent = 'No player with that username.'; return; }
  const { error } = await sb.from('streamers').insert({ user_id: p.id });
  $('#streamerMsg').textContent = error ? (error.code === '23505' ? '@' + p.username + ' is already approved.' : 'Could not approve: ' + error.message) : '@' + p.username + ' can now post videos.';
  $('#addStreamerInput').value = '';
  loadStreamers();
});
document.addEventListener('click', async (e) => {
  const en = e.target.closest('[data-endstream]');
  if (en) {
    if (en.dataset.armed !== '1') { en.dataset.armed = '1'; en.textContent = 'Tap again to delete'; return; }
    en.disabled = true;
    const { data: gone } = await sb.from('streams').delete().eq('id', en.dataset.endstream).select('id');
    if (!gone?.length) { alert('Could not delete the video. Try again.'); en.disabled = false; return; }
    $('#goLiveMsg').textContent = '';
    loadLive();
  }
  const rs = e.target.closest('[data-rmstreamer]');
  if (rs) { await sb.from('streamers').delete().eq('user_id', rs.dataset.rmstreamer); loadStreamers(); }
});
sb.auth.onAuthStateChange(() => { setTimeout(() => { if ($('#live').classList.contains('active')) loadLive(); }, 80); });
