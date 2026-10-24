'use strict';
(async () => {
  const status = document.getElementById('label-status'), print = document.getElementById('print-label'), label = document.getElementById('cabinet-label');
  const cabinet = new URLSearchParams(location.search).get('cabinet');
  const endpoint = '/api/admin/cabinet-qr?cabinet=' + encodeURIComponent(cabinet || '');
  try {
    const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to the admin, then reopen this label.' : 'Cabinet label unavailable. Check the cabinet ID in Stations.');
    const details = await response.json();
    document.getElementById('label-cabinet').textContent = details.cabinetId;
    document.getElementById('label-domain').textContent = new URL(details.url).hostname;
    document.title = 'Smile · ' + details.cabinetId + ' · QR label';
    const image = document.getElementById('label-qr');
    image.src = endpoint + '&format=png';
    await image.decode();
    label.hidden = false; print.disabled = false;
    status.textContent = details.deviceConfigured ? 'Label ready. Scanning opens the rental page; it does not release a power bank.' : 'Label ready. Configure this cabinet’s device connection before allowing rentals.';
    print.addEventListener('click', () => window.print());
  } catch (error) { status.textContent = error.message; label.hidden = true; print.disabled = true; }
})();
