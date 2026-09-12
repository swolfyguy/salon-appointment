/* =====================================================================
   SHOP CONFIGURATION
   Everything a shop owner is likely to change lives in this one file.
   Edit the values, save, and reload. No build step needed.
   ===================================================================== */
window.SALON_CONFIG = {
  name: "Faded Lines",
  suburb: "Bentleigh",
  tagline: "Sharp lines, Bentleigh.",
  blurb: "Fades, classic cuts and beard work on Centre Road since 2016. Walk in, or lock in a chair.",
  address: "271 Centre Rd, Bentleigh VIC 3204",
  phone: "+61395570000",
  phoneDisplay: "(03) 9557 0000",
  locale: "en-AU",
  timezone: "Australia/Melbourne",
  refPrefix: "FL",

  /* Opening hours as [open, close] in 24h decimal. null = closed.
     Index is the JavaScript weekday: 0 = Sunday ... 6 = Saturday. */
  hours: {
    0: [10, 17],
    1: null,
    2: [9, 19],
    3: [9, 19],
    4: [9, 19],
    5: [9, 19],
    6: [9, 18],
  },
  hoursText: "Tue to Fri 9am to 7pm. Sat 9am to 6pm. Sun 10am to 5pm. Closed Mondays.",

  slotMinutes: 15,      // gap between bookable start times
  leadMinutes: 30,      // earliest a same-day booking can start, measured from now
  daysAhead: 14,        // how far ahead people can book
  cancelHours: 24,      // free cancellation window, used in copy

  /* Payment: this build takes no payment online. Cards are settled in the shop.
     To hold a card with Stripe, mount Stripe Elements in the #card-mount
     container (see app.js, "PAYMENT") and add a server to create the SetupIntent. */
  paymentNote: "Nothing to pay now. Settle up in the chair by card or cash. Prices include GST.",

  /* Optional: POST every confirmed booking as JSON to this URL (Formspree, Make,
     Zapier, or your own endpoint). Leave empty to keep bookings on the customer's
     device only. */
  bookingEndpoint: "",

  /* Photos. Unsplash IDs are resized on the fly. To use your own files, replace
     `id` with `src: "assets/img/your-photo.jpg"`. */
  images: {
    hero: { id: "1503951914875-452162b0f3f1", alt: "A barber trimming a client's beard with scissors" },
    rail: { id: "1585747860715-2ba37e788b70", alt: "Barber chairs in front of mirrors in a brick-walled shop" },
    gallery: [
      { id: "1585747860715-2ba37e788b70", alt: "The shop floor with three chairs" },
      { id: "1621605815971-fbc98d665033", alt: "Clippers, scissors and combs laid out on a bench" },
      { id: "1512690459411-b9245aed614b", alt: "A leather barber chair" },
      { id: "1536520002442-39764a41e987", alt: "A long row of chairs under pendant lights" },
    ],
  },

  /* Staff. base = starting price for a haircut. daysOff = weekdays off (0 = Sunday). */
  barbers: [
    { id: "dom",   name: "Dom",   initials: "D", note: "Skin fades, tapers",         base: 70, daysOff: [],  photo: { id: "1583864697784-a0efc8379f70", alt: "Dom" } },
    { id: "marco", name: "Marco", initials: "M", note: "Classic cuts, scissor work", base: 55, daysOff: [0], photo: { id: "1618077360395-f3068be8e001", alt: "Marco" } },
    { id: "sami",  name: "Sami",  initials: "S", note: "Beards, hot towel shaves",   base: 45, daysOff: [6], photo: { id: "1567894340315-735d7c361db0", alt: "Sami" } },
    { id: "any",   name: "Any barber", initials: "★", note: "Whoever's free soonest", base: 45, any: true },
  ],

  /* Services. mult scales each barber's base price. mins = chair time. */
  services: [
    { id: "cut",   name: "Haircut",         desc: "Wash, cut and style",         mins: 45, mult: 1,    photo: { id: "1622286342621-4bd786c2447c", alt: "A barber cutting hair" } },
    { id: "fade",  name: "Skin fade",       desc: "Taken down to the skin",      mins: 45, mult: 1.07, photo: { id: "1593702275687-f8b402bf1fb5", alt: "Clippers fading the side of a head" } },
    { id: "beard", name: "Beard trim",      desc: "Shaped and lined up",         mins: 20, mult: 0.43, photo: { id: "1517832606299-7ae9b720a186", alt: "Scissors shaping a beard" } },
    { id: "shave", name: "Hot towel shave", desc: "Straight razor, full finish", mins: 30, mult: 0.79, photo: { id: "1532710093739-9470acff878f", alt: "Lather being brushed onto a face" } },
    { id: "kids",  name: "Kids cut",        desc: "Twelve and under",            mins: 30, mult: 0.64, photo: { id: "1493256338651-d82f7acb2b38", alt: "A neat taper with clippers" } },
  ],
};
