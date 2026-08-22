# Dashboard auth via Cloudflare Access with a swap seam

Login is fronted by Cloudflare Access (email OTP, zero auth code, no password storage), free up to 50 authenticated users forever. Per-user data scoping (accounts, automations, budgets, conversations) is enforced in application code, never assumed from Access alone. Access is priced separately from the $5 Workers plan and jumps to $7/user/month beyond 50 users, so the auth layer is built behind a thin interface (a getUser() boundary) allowing a swap to self-built email-magic-link auth in D1 once the product approaches 50 real users.

Status: accepted
