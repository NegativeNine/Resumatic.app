# Beta invite email

Send this after adding the person's address with `POST /admin/invites`. Replace the bracketed parts. It must go to the same address as their Google account, because sign-in checks the invite list against that address.

Send it from support@resumatic.app, so replies reach the team and the address matches the one in the privacy notice. Put the lockup at the top. The app serves it at https://app.resumatic.app/email/resumatic-lockup.png (`public/email/resumatic-lockup.png`): the lockup, the green tile with its check and the name in ink, on white, at twice its display size. Show it 218 px wide and 44 px tall, with the alt text "Resumatic". It stays legible when a mail client darkens the message, because it carries its own white ground. Redraw it with `node scripts/draw-email-lockup.mjs`.

---

**From:** Resumatic <support@resumatic.app>

**Subject:** Your invitation to the Resumatic beta

![Resumatic](https://app.resumatic.app/email/resumatic-lockup.png)

Hi [first name],

You're invited to the private beta of Resumatic. It tailors your resume to each job using only facts you've confirmed, and shows you the words each line came from.

**How it works**

1. Sign in at [https://app.resumatic.app] with the Google account for [their email address].
2. On Facts, upload your current resume or CV as a PDF or Word (.docx) file. Resumatic reads it and finds roles and facts for you to check, each shown next to the exact words it came from.
3. Say “That’s right” to the facts that are true, fix the ones that are nearly right, and leave out the rest.
4. Under Jobs, paste a job description and tailor a resume to it. Resumatic writes each line from your confirmed facts, checks every line against them, and lists what the job asks for that your record doesn’t show.
5. Read the resume, see where any line came from beside the page, and download the PDF.

It never invents a claim. A requirement you don't meet becomes a question for you, not a line on your resume.

**Your data.** Your record is kept in its own database, separate from everyone else’s. You can download all of it or delete your account at any time from Account. The [privacy notice](https://app.resumatic.app/#/privacy) explains how AI services are used.

**During the beta** you get [20] documents a month: each tailored resume, cover letter or interview preparation is one. Things will change and some will break. When something goes wrong or could be better, reply to this email.

Thanks for trying it,
[Your name]
