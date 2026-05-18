export async function renderTest(container) {
  container.innerHTML =
    '<header class="page-header">' +
    '<div class="page-header-main">' +
    '<h2 class="page-title">Test</h2>' +
    '<p class="page-subtitle">A simple test page.</p>' +
    '</div>' +
    '</header>' +
    '<div class="page-body">' +
    '<section class="card empty-state-card">' +
    '<p class="empty-state">Test page is ready.</p>' +
    '</section>' +
    '</div>';
}
