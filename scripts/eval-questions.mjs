// Shared question set + mechanical scoring for the model evals.
// tier 1 = legacy-API traps; tier 2 = recent-era systems (post-2023 Drupal).
export const QUESTIONS = [
  {
    id: "route",
    tier: 1,
    q: "In Drupal 10, how do I register a route for the path /hello that returns rendered output from a custom module? Show code.",
    kq: "custom module route path controller routing yaml",
    fail: [/hook_menu\b/],
    pass: [/\.routing\.yml|routing\.yml|routes:/, /Controller/],
  },
  {
    id: "message",
    tier: 1,
    q: "In Drupal 10 custom module code, how do I show a status message to the user? Show code.",
    kq: "messenger service addStatus status message",
    fail: [/drupal_set_message/],
    pass: [/messenger/i],
  },
  {
    id: "dbquery",
    tier: 1,
    q: "In Drupal 10, how do I run a SELECT query against the site database from a custom module? Show code.",
    kq: "database connection select query service injection",
    fail: [/db_query\s*\(/],
    pass: [/::database\(\)|->query\(|Connection\s*\$|Drupal\\Core\\Database\\Connection|'database'/],
  },
  {
    id: "currentuser",
    tier: 1,
    q: "In Drupal 10 custom module code, how do I get the currently logged-in user account? Show code.",
    kq: "current user account service getCurrentAccount",
    fail: [/global \$user|\$user->uid/],
    pass: [/currentUser|current_user/i],
  },
  {
    id: "sdc",
    tier: 2,
    q: "In Drupal 10.3+, what is the recommended way to create a reusable front-end component with its template, CSS and JS colocated in one directory? Name the system.",
    kq: "single directory components SDC component theme",
    fail: [],
    pass: [/SDC|Single Directory Component|single directory component/i],
  },
  {
    id: "recipes",
    tier: 2,
    q: "In Drupal 10.3+, how can a module or distribution ship default configuration and content so another site can apply it as one unit? Name the system.",
    kq: "recipe install configuration content apply",
    fail: [],
    pass: [/\brecipe/i],
  },
  {
    id: "ckeditor",
    tier: 2,
    q: "Which text editor is Drupal 10's default, and what replaced the editor that Drupal 9 shipped with?",
    kq: "CKEditor 5 default text editor replacement",
    fail: [],
    pass: [/CKEditor\s*5/i],
  },
  {
    id: "phpfloor",
    tier: 2,
    q: "What is the minimum PHP version Drupal 11 requires?",
    kq: "Drupal 11 requirements PHP 8.3 composer.json",
    fail: [/minimum[^.\n]*8\.[12]\b/i],
    pass: [/8\.3/],
  },
];

export function score(answer, q) {
  return {
    failHits: q.fail.filter((re) => re.test(answer)).map(String),
    passCount: q.pass.filter((re) => re.test(answer)).length,
  };
}