# CES website

The public site remains static HTML with its existing page layouts and styles.

Edit `shared/public-content.json` for the public contact address, mailing-list link, recruitment contacts, or alumni names. Run `npm run sync:public` and commit the generated HTML alongside the content file. This updates all nine public pages without adding browser dependencies or changing the design.
