<?php
/**
 * Sweep repair recipe: remove a half-installed module from core.extension so
 * the kernel can bootstrap again.
 *
 * This runs PDO-direct (no Drupal bootstrap) because the whole point is that
 * the site cannot bootstrap: a module was written to core.extension before its
 * container entry compiled, so every drush command fatals. It must therefore
 * run via plain `ddev exec php`, NOT `drush php:script`.
 *
 * Harness-owned: staged into the scratch site by the half-install-state target
 * so the recipe travels with the harness rather than depending on an untracked
 * file in the fixture checkout (that dependency is why the first scratch run
 * recorded `repair exit=1` — the file simply was not in the clone).
 *
 * Usage inside the container: php /var/www/html/scripts/repair-core-extension.php <module>
 */
$c = new PDO('mysql:host=db;dbname=db', 'db', 'db');
$row = $c->query("SELECT data FROM config WHERE name='core.extension'")->fetch(PDO::FETCH_ASSOC);
if (!$row) {
  fwrite(STDERR, "core.extension row not found\n");
  exit(1);
}
$data = unserialize($row['data']);
$name = $argv[1] ?? 'usagov_benefit_finder_api';
if (!isset($data['module'][$name])) {
  // Nothing to repair is NOT an error for the recipe's purpose, but the sweep
  // wants to know the module was actually present, so say so and exit 0.
  echo "module $name not present in core.extension; nothing to remove\n";
  exit(0);
}
unset($data['module'][$name]);
$stmt = $c->prepare('UPDATE config SET data = ? WHERE name = ?');
$stmt->execute([serialize($data), 'core.extension']);
echo "removed $name; enabled modules now: " . count($data['module']) . "\n";
