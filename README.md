# CES website

The public site remains static HTML with its existing page layouts and styles.

Edit `shared/public-content.json` for the public contact address, mailing-list link, recruitment contacts, or alumni names. Run `npm run sync:public` and commit the generated HTML alongside the content file. This updates all nine public pages without adding browser dependencies or changing the design.

The homepage calendar and Events page use the same published event feed at `https://admin.cueconsociety.com/api/events`. Manage records in the admin website's Events tab. Publish makes an event visible in both places; draft, archive, and deletion remove it from the public feed. Both views refresh while open and when returning to the page. There is no separate calendar to maintain. Dates follow New York time; event time text is displayed as entered. Run `node --test tests/events.test.js tests/calendar.test.js` for date, visibility, and calendar checks.
