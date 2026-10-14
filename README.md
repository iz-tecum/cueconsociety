# CES website

The public site remains static HTML with its existing page layouts and styles.

Edit `shared/public-content.json` for the public contact address, mailing-list link, recruitment contacts, or alumni names. Run `npm run sync:public` and commit the generated HTML alongside the content file. This updates all ten public pages and their static navigation. Shared menu styles and behavior live in `assets/site-navigation.css` and `assets/site-navigation.js`.

Manage public events in the admin website's Events tab. The Events page reads `https://admin.cueconsociety.com/api/events` and refreshes while open and when returning to the page. Publishing adds an event to the public feed; draft, archive, and deletion remove it. Dates follow New York time; event time text is displayed as entered. Run `node --test tests/events.test.js` for date and visibility checks.

The homepage embeds Google Calendar below the gallery and above the sponsors. Google subscribes to `https://admin.cueconsociety.com/api/events/calendar.ics` (calendar ID `ubsjsp8fgge92b9tggocgq47q3f132te@import.calendar.google.com`), so event details remain managed in the admin panel. Google controls when it refreshes that subscription; changes may take time to appear in the embedded calendar, and no refresh time is guaranteed. The Events page provides the current published record. The embed opens in month view on larger screens and agenda view on phones, using the America/New_York time zone.
