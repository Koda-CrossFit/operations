/**
 * Mail.js: every email the site sends (SPEC section 10).
 *
 * All of it goes through sendMail_, which is where test mode lives: unless Settings.live
 * is TRUE, an email goes only to test_email with [TEST to <name>] in the subject. There's
 * no other path to MailApp, except the job-failure note, which only ever goes to test_email.
 * No dollar amounts, anywhere.
 */

/** Returns true if an email went out. A live email with no address on file just doesn't send. */
function sendMail_(to, who, subject, html) {
  var settings = settings_();
  var live = isTrue_(settings.live);
  var address = live ? text_(to) : text_(settings.test_email);
  if (!address) {
    log_('system', 'email not sent', 'No address for ' + who + ': ' + subject);
    return false;
  }
  var message = {
    to: address,
    subject: live ? subject : '[TEST to ' + who + '] ' + subject,
    htmlBody: html,
    body: plainText_(html),
    name: APP_NAME_,
  };
  var replyTo = text_(settings.reply_to);
  if (replyTo) message.replyTo = replyTo;
  MailApp.sendEmail(message);
  log_('system', 'email', who + ': ' + subject);
  return true;
}

/**
 * For an email that goes along with a person's own action. The action has already been
 * saved, so a mail problem is logged and doesn't come back to them as an error.
 */
function bestEffort_(what, send) {
  try {
    return send();
  } catch (err) {
    console.error('Email failed, ' + what + ': ' + ((err && err.stack) || err));
    log_('system', 'email failed', what + ': ' + ((err && err.message) || err));
    return false;
  }
}

/** At most a few alerts about one person per hour, so a script hammering the web app can't use up the day's mail quota before Friday's emails. */
function alertAllowed_(name) {
  var cache = CacheService.getScriptCache();
  var key = 'alerts_' + name;
  var count = Number(cache.get(key)) || 0;
  if (count >= ALERTS_PER_HOUR_) return false;
  cache.put(key, String(count + 1), 3600);
  return true;
}

/** Managers get one shared email. */
function sendToManagers_(subject, html) {
  var emails = parseList_(settings_().manager_emails);
  if (!emails.length) {
    emails = activeStaff_()
      .filter(function (person) {
        return person.type === 'Manager' && person.email;
      })
      .map(function (person) {
        return person.email;
      });
  }
  return sendMail_(emails.join(','), 'Managers', subject, html);
}

function plainText_(html) {
  return String(html)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g, '$2: $1')
    .replace(/<\/(p|div|tr|li|h1|h2|h3|table|ul)>/g, '\n')
    .replace(/<\/t[dh]>/g, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A deep link into the site. Emails sign people straight in, the way the site expects. */
function siteLink_(name, tab, week) {
  var base = text_(settings_().site_url) || DEFAULT_SITE_URL_;
  var query = [];
  if (name) query.push('me=' + encodeURIComponent(name));
  if (tab) query.push('tab=' + encodeURIComponent(tab));
  if (week) query.push('week=' + encodeURIComponent(week));
  return base + (query.length ? (base.indexOf('?') >= 0 ? '&' : '?') + query.join('&') : '');
}

/** Simple white page, navy button, short. */
function mailPage_(bodyHtml, button) {
  var action = '';
  if (button) {
    action =
      '<p style="margin:28px 0 8px"><a href="' +
      esc_(button.url) +
      '" style="background:#16324F;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:12px;display:inline-block">' +
      esc_(button.label) +
      '</a></p>';
  }
  return (
    '<div style="background:#ffffff;color:#27323F;font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 20px">' +
    bodyHtml +
    action +
    '<p style="margin:28px 0 0;color:#5F6B7A;font-size:13px">' +
    esc_(APP_NAME_) +
    '</p></div>'
  );
}

function para_(text) {
  return '<p style="margin:0 0 14px">' + esc_(text) + '</p>';
}

function subhead_(text) {
  return '<h3 style="margin:22px 0 8px;font-size:16px;color:#0C1A2B">' + esc_(text) + '</h3>';
}

function list_(items) {
  return (
    '<ul style="margin:0 0 14px;padding-left:20px">' +
    items
      .map(function (item) {
        return '<li style="margin:0 0 4px">' + esc_(item) + '</li>';
      })
      .join('') +
    '</ul>'
  );
}

/** A plain table from header cells and rows of text. */
function table_(headers, rows) {
  var cell = function (tag, value, first) {
    return '<' + tag + ' style="text-align:' + (first ? 'left' : 'right') + ';padding:5px 14px 5px 0;border-bottom:1px solid #E5E9EF">' + esc_(value) + '</' + tag + '>';
  };
  var line = function (tag, values) {
    return (
      '<tr>' +
      values
        .map(function (value, index) {
          return cell(tag, value, index === 0);
        })
        .join('') +
      '</tr>'
    );
  };
  return '<table style="border-collapse:collapse;margin:0 0 14px">' + line('th', headers) + rows.map(line.bind(null, 'td')).join('') + '</table>';
}

/** Minutes as hours for a person to read: 340 -> '5.7'. */
function hoursText_(minutes) {
  return String(Math.round((minutes / 60) * 10) / 10);
}

function rowLine_(row) {
  return dayLabel_(row.date) + ': ' + row.title;
}

/* -------------------------------------------------------------------- staff ---- */

function availabilitySubject_(weekOf) {
  return APP_NAME_ + ': availability for the week of ' + monthDay_(weekOf);
}

/** Sent when the Friday run finds no availability. */
function mailMissedDeadline_(person, weekOf) {
  var html = mailPage_(
    para_(
      'Hi ' +
        firstName_(person.name) +
        ", we don't have your availability for the week of " +
        monthDay_(weekOf) +
        " yet. It was due this morning at 7 AM and the schedule just went out. Fill it out now and you'll pick up any tasks that are left."
    ),
    { label: 'Fill out availability', url: siteLink_(person.name, 'availability', weekOf) }
  );
  return sendMail_(person.email, person.name, availabilitySubject_(weekOf), html);
}

/** The Thursday heads-up, off by default. */
function mailHeadsUp_(person, weekOf) {
  var html = mailPage_(
    para_(
      'Hi ' +
        firstName_(person.name) +
        ', your availability for the week of ' +
        monthDay_(weekOf) +
        " is due tomorrow at 7 AM. If you don't send it in by then, you'll only get the tasks left over."
    ),
    { label: 'Fill out availability', url: siteLink_(person.name, 'availability', weekOf) }
  );
  return sendMail_(person.email, person.name, availabilitySubject_(weekOf), html);
}

/** The manager's "Send reminder now". It says what's true right now, before or after the deadline. */
function mailReminder_(person, weekOf) {
  var hello = 'Hi ' + firstName_(person.name) + ", we don't have your availability for the week of " + monthDay_(weekOf) + ' yet. ';
  var body = pastDeadline_(weekOf, nowInfo_())
    ? "The deadline has passed. Fill it out now and you'll pick up any tasks that are left."
    : 'It is due ' + deadlineLabel_(weekOf) + '.';
  var html = mailPage_(para_(hello + body), { label: 'Fill out availability', url: siteLink_(person.name, 'availability', weekOf) });
  return sendMail_(person.email, person.name, availabilitySubject_(weekOf), html);
}

function scheduleSubject_(weekOf) {
  return 'Your Koda schedule: week of ' + monthDay_(weekOf);
}

/** Each working day with its time and tasks. */
function mailYourWeek_(person, weekOf) {
  var rows = scheduleForWeek_(weekOf).filter(function (row) {
    return row.name === person.name;
  });
  var sections = weekDates_(weekOf)
    .map(function (date) {
      var dayRows = sortRows_(
        rows.filter(function (row) {
          return row.date === date;
        })
      );
      if (!dayRows.length) return '';
      var shift = shiftFor_(person.name, date);
      return (
        subhead_(dayLabel_(date) + (shift ? ', ' + shift.start + ' - ' + shift.end : '')) +
        list_(
          dayRows.map(function (row) {
            return row.title;
          })
        )
      );
    })
    .join('');
  var html = mailPage_(para_('Hi ' + firstName_(person.name) + ", here's your week.") + sections + para_('Remember to clock in and out.'), {
    label: 'Open ' + APP_NAME_,
    url: siteLink_(person.name, 'today'),
  });
  return sendMail_(person.email, person.name, scheduleSubject_(weekOf), html);
}

function mailNothingThisWeek_(person, weekOf) {
  var html = mailPage_(para_('Hi ' + firstName_(person.name) + ", there's nothing on your list for the week of " + monthDay_(weekOf) + ', but thanks for sending your availability.'));
  return sendMail_(person.email, person.name, scheduleSubject_(weekOf), html);
}

/* ----------------------------------------------------------------- managers ---- */

/** Uncovered tasks, who didn't submit, and wanted against assigned hours. */
function mailManagerSummary_(weekOf) {
  var rows = scheduleForWeek_(weekOf);
  var uncovered = sortRows_(
    rows.filter(function (row) {
      return !row.name;
    })
  );
  var missing = missingAvailability_(weekOf).map(function (person) {
    return person.name;
  });
  var noEmail = activeStaff_()
    .filter(function (person) {
      return !person.email && person.type !== 'Manager';
    })
    .map(function (person) {
      return person.name;
    });
  var wantedLines = activeStaff_()
    .filter(function (person) {
      return person.type === 'Flexible';
    })
    .map(function (person) {
      var availability = availabilityRow_(person.name, weekOf);
      var assigned = rows
        .filter(function (row) {
          return row.name === person.name;
        })
        .reduce(function (sum, row) {
          return sum + row.minutes;
        }, 0);
      var wanted = !availability ? 'no answer' : availability.none ? "can't work" : String(availability.hoursWanted);
      return [person.name, wanted, hoursText_(assigned)];
    });

  var body = para_('The schedule for the week of ' + monthDay_(weekOf) + ' just went out.');
  body += subhead_('Uncovered tasks');
  body += uncovered.length ? list_(uncovered.map(rowLine_)) : para_('Nothing is uncovered.');
  body += subhead_("Didn't submit availability");
  body += para_(missing.length ? missing.join(', ') : 'Everyone submitted.');
  body += subhead_('Hours wanted and assigned');
  body += table_(['Name', 'Wanted', 'Assigned'], wantedLines);
  if (noEmail.length) body += para_('No email on file: ' + noEmail.join(', ') + '.');
  var unreadable = unreadableClosedDays_();
  if (unreadable.length) body += para_('These lines on the Closed Days tab are not dates we can read, so work was scheduled as usual: ' + unreadable.join(', ') + '. Please type them like 12/25/2026.');
  return sendToManagers_('Week of ' + monthDay_(weekOf) + ' schedule is out', mailPage_(body, { label: 'Open ' + APP_NAME_, url: siteLink_('', 'manage') }));
}

/** Someone is out of town, and what got covered or not. */
function mailManagerOutOfTown_(person, from, to, affected) {
  var body = para_(person.name + ' will be out of town ' + rangeLabel_(from, to) + '.');
  body += list_(
    affected.map(function (item) {
      return dayLabel_(item.date) + ': ' + item.title + ' - ' + (item.coveredBy ? 'covered by ' + item.coveredBy : 'not covered');
    })
  );
  return sendToManagers_(person.name + ' is out of town ' + rangeLabel_(from, to), mailPage_(body, { label: 'Open ' + APP_NAME_, url: siteLink_('', 'manage') }));
}

/**
 * A late submission, or a change after the deadline from someone who was on time: what they
 * picked up, anything they let go of that nobody has, and anything that no longer fits.
 */
function mailManagerLate_(person, weekOf, picked, dropped, late, overage) {
  var week = 'the week of ' + monthDay_(weekOf);
  var body = para_(late ? person.name + "'s availability for " + week + ' came in after the deadline.' : person.name + ' changed their availability for ' + week + ' after the deadline.');
  body += subhead_('Picked up');
  body += picked.length ? list_(picked) : para_('Nothing.');
  if (dropped.length) {
    body += subhead_('Let go, now uncovered');
    body += list_(dropped);
  }
  if (overage.length) {
    body += subhead_('No longer fits');
    body += list_(overage);
    body += para_('Nothing was moved for this. Use Manage to move it if it needs to change.');
  }
  var subject = person.name + (late ? "'s availability came in late: week of " : "'s availability changed: week of ") + monthDay_(weekOf);
  return sendToManagers_(subject, mailPage_(body, { label: 'Open ' + APP_NAME_, url: siteLink_('', 'manage') }));
}

/** Someone Flexible took back their out-of-town dates, and what they picked back up. */
function mailManagerBackInTown_(person, entry, restored) {
  var body = para_(person.name + ' is no longer out of town ' + rangeLabel_(entry.from, entry.to) + ' and picked these back up.');
  body += list_(restored.map(rowLine_));
  return sendToManagers_(person.name + ' is back in town ' + rangeLabel_(entry.from, entry.to), mailPage_(body, { label: 'Open ' + APP_NAME_, url: siteLink_('', 'manage') }));
}

/** Last month's totals per person, and any entries that still need a fix. */
function mailMonthlyHours_(month) {
  var info = nowInfo_();
  var entries = hoursRows_().filter(function (entry) {
    return monthOf_(entry.date) === month;
  });
  var totals = staff_()
    .filter(function (person) {
      return (person.active && person.type !== 'Manager') || entries.some(function (entry) {
        return entry.name === person.name;
      });
    })
    .map(function (person) {
      return [
        person.name,
        String(
          totalHours_(
            entries.filter(function (entry) {
              return entry.name === person.name;
            })
          )
        ),
      ];
    });
  var issues = entries.filter(function (entry) {
    return entryHasIssue_(entry, info);
  });
  var longOnes = entries.filter(entryRunsLong_);
  var body = para_('Hours for ' + monthYearLabel_(month) + '.');
  body += table_(['Name', 'Hours'], totals);
  body += subhead_('Needs a fix');
  body += issues.length
    ? list_(
        issues.map(function (entry) {
          var what = entry.outAt ? timeLabel_(entry.inAt) + ' - ' + timeLabel_(entry.outAt) + ', on top of another entry' : 'clocked in ' + timeLabel_(entry.inAt) + ', no clock-out';
          return entry.name + ': ' + dayLabel_(entry.date) + ', ' + what;
        })
      )
    : para_('Nothing needs a fix.');
  if (longOnes.length) {
    body += subhead_('Much longer than scheduled');
    body += list_(
      longOnes.map(function (entry) {
        return entry.name + ': ' + dayLabel_(entry.date) + ', ' + timeLabel_(entry.inAt) + ' - ' + timeLabel_(entry.outAt) + ', ' + entryHours_(entry) + ' hours';
      })
    );
  }
  return sendToManagers_(monthName_(month) + ' hours', mailPage_(body, { label: 'Open ' + APP_NAME_, url: siteLink_('', 'manage') }));
}

/** When an automation job throws. Only ever goes to test_email. */
function mailJobFailed_(job, err) {
  var address = text_(settings_().test_email);
  if (!address) return;
  MailApp.sendEmail({
    to: address,
    subject: APP_NAME_ + ': the ' + job + ' job failed',
    htmlBody: mailPage_(para_('The ' + job + ' job failed at ' + stampLabel_(Now_()) + '. It will try again on the next run.') + para_(String((err && err.message) || err))),
    body: 'The ' + job + ' job failed at ' + stampLabel_(Now_()) + '. It will try again on the next run.\n\n' + String((err && err.message) || err),
    name: APP_NAME_,
  });
}
