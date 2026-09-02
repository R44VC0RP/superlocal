import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Icon, IconButton, Key, Modal } from "./components";
import { loadSaved, type Preferences } from "./data";
import { writeSaved } from "./storage";
import "./auxiliary.css";

type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  allDay: boolean;
  color: "blue" | "violet" | "green" | "ochre";
  calendar?: string;
};
type CalendarSource = { id: string; name: string; checked: boolean };
type BookingPage = { id: string; title: string; duration: number };
type Props = {
  onBack: () => void;
  account: string;
  preferences: Preferences;
  onOpenSettings?: () => void;
  onShareAvailability?: () => void;
  initialView?: "day" | "week";
};
type View = "day" | "week" | "month";
const HOUR_HEIGHT = 44;
const dateValue = (day: string) => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, amount: number) => {
  const date = dateValue(day);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const dateLabel = (day: string, options: Intl.DateTimeFormatOptions) =>
  dateValue(day).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

function wallTime(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function toInstant(wall: string, timezone: string) {
  const target = Date.parse(`${wall}Z`);
  if (!Number.isFinite(target))
    throw new Error("Enter a valid start and end time.");
  let instant = target;
  // Resolve a wall-clock input in the selected zone, including daylight-saving offsets.
  for (let attempt = 0; attempt < 4; attempt++) {
    const difference =
      target -
      Date.parse(`${wallTime(new Date(instant).toISOString(), timezone)}Z`);
    if (!difference) return new Date(instant).toISOString();
    instant += difference;
  }
  throw new Error(
    "That time does not exist in this time zone. Choose a different time.",
  );
}

function seedEvents(): CalendarEvent[] {
  const meetings = [
    [
      "camera",
      "Camera mount review",
      "2026-09-01T11:00",
      "2026-09-01T12:00",
      "Studio",
      "Review the next prototype with Alex.",
      "blue",
    ],
    [
      "design",
      "Design catch-up",
      "2026-09-02T14:00",
      "2026-09-02T14:30",
      "Google Meet",
      "Walk through the latest designs and next steps with Jamie Chen.",
      "violet",
    ],
    [
      "studio",
      "Studio project review",
      "2026-09-03T10:00",
      "2026-09-03T11:00",
      "Studio",
      "Review the project plan and production schedule.",
      "blue",
    ],
  ];
  return [
    ...meetings.map(
      ([id, title, start, end, location, description, color]) => ({
        id,
        title,
        start: toInstant(start, "America/New_York"),
        end: toInstant(end, "America/New_York"),
        location,
        description,
        allDay: false,
        color: color as CalendarEvent["color"],
      }),
    ),
    {
      id: "labor-day",
      title: "Labor Day",
      start: "2026-09-07",
      end: "2026-09-08",
      location: "",
      description: "",
      allDay: true,
      color: "green",
    },
  ];
}

export default function CalendarView(props: Props) {
  return <Calendar key={props.account} {...props} />;
}

function Calendar({
  onBack,
  account,
  preferences,
  onOpenSettings,
  onShareAvailability,
  initialView = "week",
}: Props) {
  let timezone = preferences.timezone || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    timezone = "UTC";
  }
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    const saved = loadSaved<CalendarEvent[]>(
      `calendar:${account}`,
      seedEvents(),
    );
    return Array.isArray(saved)
      ? saved.filter(
          (event) =>
            event &&
            typeof event.title === "string" &&
            Number.isFinite(Date.parse(event.start)) &&
            Number.isFinite(Date.parse(event.end)),
        )
      : seedEvents();
  });
  const [day, setDay] = useState("2026-09-01");
  const [miniMonth, setMiniMonth] = useState("2026-09-01");
  const [view, setView] = useState<View>(initialView);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [meet, setMeet] = useState("");
  const [calendarsExpanded, setCalendarsExpanded] = useState(true);
  const [sources, setSources] = useState<CalendarSource[]>(() =>
    loadSaved(`calendar-sources:${account}`, [
      { id: account, name: account, checked: true },
      ...[
        "backup.pst/Calendar",
        "backup.pst/United States holidays",
        "Shared calendar",
        "Holidays in United States",
        "Project calendar",
        "Additional calendar",
      ].map((name) => ({ id: name, name, checked: false })),
    ]),
  );
  const [bookings, setBookings] = useState<BookingPage[]>(() =>
    loadSaved(`calendar-bookings:${account}`, []),
  );
  const [sidebarDialog, setSidebarDialog] = useState<
    "calendar" | "booking" | null
  >(null);
  const [sidebarTitle, setSidebarTitle] = useState("");
  const [bookingDuration, setBookingDuration] = useState("30");
  const [editor, setEditor] = useState<CalendarEvent | null>(null);
  const [calendarError, setCalendarError] = useState("");
  const [now, setNow] = useState(() => new Date().toISOString());
  const scroller = useRef<HTMLDivElement>(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const closeSidebarDialog = useCallback(() => {
    setSidebarDialog(null);
    setSidebarTitle("");
  }, []);
  const todayWall = wallTime(now, timezone);
  const today = todayWall.slice(0, 10);
  const weekStart =
    preferences.startWeek === "Monday"
      ? 1
      : preferences.startWeek === "Saturday"
        ? 6
        : 0;
  const firstOfMonth = `${day.slice(0, 7)}-01`;
  const first =
    view === "day"
      ? day
      : addDays(
          view === "month" ? firstOfMonth : day,
          -(
            dateValue(view === "month" ? firstOfMonth : day).getUTCDay() -
            weekStart +
            7
          ) % 7,
        );
  const monthEnd = new Date(
    Date.UTC(
      dateValue(day).getUTCFullYear(),
      dateValue(day).getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  const count =
    view === "day"
      ? 1
      : view === "week"
        ? 7
        : Math.ceil(
            (((dateValue(firstOfMonth).getUTCDay() - weekStart + 7) % 7) +
              monthEnd) /
              7,
          ) * 7;
  const days = Array.from({ length: count }, (_, index) =>
    addDays(first, index),
  );
  const miniFirst = addDays(
    miniMonth,
    -(dateValue(miniMonth).getUTCDay() - weekStart + 7) % 7,
  );
  const miniDays = Array.from({ length: 42 }, (_, index) =>
    addDays(miniFirst, index),
  );
  const formattedEvents = events
    .filter(
      (event) =>
        sources.find((source) => source.id === (event.calendar || account))
          ?.checked !== false,
    )
    .map((event) => ({
      ...event,
      wallStart: event.allDay ? event.start : wallTime(event.start, timezone),
      wallEnd: event.allDay ? event.end : wallTime(event.end, timezone),
    }));
  const timeLabel = (wall: string) =>
    new Date(`${wall}Z`).toLocaleTimeString("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
      hour12: preferences.timeFormat !== "24 hour",
    });
  const zoneLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")?.value;
  const last = days.at(-1)!;
  const heading =
    view === "week" && first.slice(0, 7) !== last.slice(0, 7)
      ? `${dateLabel(first, { month: "short", ...(first.slice(0, 4) !== last.slice(0, 4) ? { year: "numeric" } : {}) })} – ${dateLabel(last, { month: "short", year: "numeric" })}`
      : dateLabel(day, { month: "long", year: "numeric" });

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date().toISOString()),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (scroller.current)
      scroller.current.scrollTop = view === "month" ? 0 : 6 * HOUR_HEIGHT - 14;
  }, [view]);
  useEffect(() => setMiniMonth(`${day.slice(0, 7)}-01`), [day]);
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      editor ||
      sidebarDialog ||
      !scroller.current?.isConnected ||
      (event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        )) ||
      document.querySelector('[role="dialog"], [aria-modal="true"]')
    )
      return;
    if (
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.shiftKey &&
      event.key.toLowerCase() === "a" &&
      onShareAvailability
    ) {
      onShareAvailability();
    } else {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "b") createEvent();
      else if (!event.shiftKey && event.key === "0") setView("day");
      else if (!event.shiftKey && event.key === "2") setView("week");
      else if (!event.shiftKey && event.key === "-") navigate(-1);
      else if (!event.shiftKey && event.key === "=") navigate(1);
      else if (!event.shiftKey && event.key === "Escape") {
        if (actionsOpen) setActionsOpen(false);
        else if (sidebarOpen) setSidebarOpen(false);
        else onBack();
      } else return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcut(event);
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  function navigate(direction: number) {
    if (view !== "month")
      return setDay(addDays(day, direction * (view === "week" ? 7 : 1)));
    const date = dateValue(firstOfMonth);
    date.setUTCMonth(date.getUTCMonth() + direction);
    setDay(date.toISOString().slice(0, 10));
  }
  function createEvent(
    date = day,
    minutes = 9 * 60,
    allDay = false,
    title = "",
    duration = 60,
  ) {
    const start = `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    try {
      const instant = allDay ? date : toInstant(start, timezone);
      setEditor({
        id: "",
        title,
        start: instant,
        end: allDay
          ? addDays(date, 1)
          : new Date(Date.parse(instant) + duration * 60 * 1000).toISOString(),
        location: "",
        description: "",
        allDay,
        color: "blue",
        calendar: account,
      });
      setActionsOpen(false);
      setCalendarError("");
    } catch (cause) {
      setCalendarError(
        cause instanceof Error
          ? cause.message
          : "Choose a different start time.",
      );
    }
  }
  function saveEvents(next: CalendarEvent[]) {
    if (!writeSaved(`calendar:${account}`, next))
      throw new Error(
        "Could not save this event. Browser storage is unavailable.",
      );
    setEvents(next);
  }
  function openEvent(event: CalendarEvent) {
    setEditor({ ...events.find((existing) => existing.id === event.id)! });
  }
  function eventsOn(date: string) {
    return formattedEvents
      .filter(
        (event) =>
          event.wallStart <
            (event.allDay ? addDays(date, 1) : `${addDays(date, 1)}T00:00`) &&
          event.wallEnd > (event.allDay ? date : `${date}T00:00`),
      )
      .sort(
        (a, b) =>
          Number(b.allDay) - Number(a.allDay) ||
          a.wallStart.localeCompare(b.wallStart),
      );
  }
  function changeSources(next: CalendarSource[]) {
    if (!writeSaved(`calendar-sources:${account}`, next))
      return setCalendarError(
        "Could not save calendar settings. Browser storage is unavailable.",
      );
    setSources(next);
  }

  return (
    <section
      className={`aux-view calendar-view ${sidebarOpen ? "aux-sidebar-open" : ""}`}
      aria-label="Calendar"
    >
      <div className="aux-main calendar-main">
        <header className="aux-header calendar-header">
          <button
            className="aux-button calendar-today"
            onClick={() => {
              const instant = new Date().toISOString();
              setDay(wallTime(instant, timezone).slice(0, 10));
              setNow(instant);
            }}
          >
            Today
          </button>
          <div className="calendar-navigation">
            <IconButton
              name="ChevronRight"
              className="calendar-previous"
              title={`Previous ${view} (-)`}
              onClick={() => navigate(-1)}
            />
            <IconButton
              name="ChevronRight"
              title={`Next ${view} (=)`}
              onClick={() => navigate(1)}
            />
          </div>
          <h1>
            <button
              aria-label={`${heading}, calendar view and actions`}
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen(!actionsOpen)}
            >
              {heading}
            </button>
          </h1>
          <IconButton
            name="Calendar"
            title="Show calendar sidebar"
            className="aux-mobile-sidebar-button"
            onClick={() => setSidebarOpen(true)}
          />
          {actionsOpen && (
            <>
              <button
                className="aux-menu-dismiss"
                aria-label="Close calendar menu"
                onClick={() => setActionsOpen(false)}
              />
              <div className="calendar-actions-menu">
                <label className="calendar-view-picker">
                  <select
                    aria-label="Calendar view"
                    title="Day (0), week (2)"
                    value={view}
                    onChange={(e) => setView(e.target.value as View)}
                  >
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                  </select>
                  <Icon name="ChevronDown" size={12} />
                </label>
                <button
                  className="aux-button aux-primary"
                  title="New event (B or Shift+B)"
                  onClick={() => createEvent()}
                >
                  <Icon name="Plus" />
                  <span>New event</span>
                </button>
                <button className="aux-button" onClick={onBack}>
                  <Icon name="Back" />
                  Back to mail
                </button>
              </div>
            </>
          )}
        </header>
        {calendarError && (
          <div className="calendar-error" role="alert">
            <span>{calendarError}</span>
            <IconButton
              name="Close"
              title="Dismiss calendar error"
              onClick={() => setCalendarError("")}
            />
          </div>
        )}
        <div className={`calendar-scroll calendar-${view}`} ref={scroller}>
          {view === "month" ? (
            <div className="calendar-month-content">
              <div className="calendar-month-weekdays">
                {days.slice(0, 7).map((date) => (
                  <span key={date}>
                    {dateLabel(date, { weekday: "short" })}
                  </span>
                ))}
              </div>
              <div
                className="calendar-month-grid"
                style={{
                  gridTemplateRows: `repeat(${count / 7}, minmax(110px, 1fr))`,
                }}
              >
                {days.map((date) => (
                  <div
                    key={date}
                    className={`calendar-month-day ${date.slice(0, 7) !== day.slice(0, 7) ? "outside-month" : ""}`}
                  >
                    <div className="calendar-month-day-header">
                      <button
                        className={`calendar-date-number ${date === today ? "is-today" : ""}`}
                        aria-label={`Show ${dateLabel(date, { dateStyle: "full" })}`}
                        onClick={() => {
                          setDay(date);
                          setView("day");
                        }}
                      >
                        {Number(date.slice(-2))}
                      </button>
                      <IconButton
                        name="Plus"
                        title={`Create event on ${dateLabel(date, { month: "long", day: "numeric" })}`}
                        size={12}
                        onClick={() => createEvent(date)}
                      />
                    </div>
                    {eventsOn(date).map((event) => (
                      <button
                        key={event.id}
                        className={`calendar-month-event calendar-color-${event.color} ${event.end <= (event.allDay ? today : now) ? "is-past" : ""}`}
                        onClick={() => openEvent(event)}
                        title={`${event.title}${event.allDay ? "" : `, ${timeLabel(event.wallStart)}`}`}
                      >
                        {!event.allDay && (
                          <span>{timeLabel(event.wallStart)}</span>
                        )}
                        <strong>{event.title}</strong>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              className="calendar-time-content"
              style={{ "--calendar-days": count } as CSSProperties}
            >
              <div className="calendar-sticky-header">
                <div className="calendar-days-heading">
                  <div className="calendar-zone" title={timezone}>
                    {zoneLabel}
                  </div>
                  {days.map((date) => (
                    <button
                      key={date}
                      className={`calendar-day-heading ${date === today ? "is-today" : ""}`}
                      onClick={() => {
                        setDay(date);
                        setView("day");
                      }}
                      aria-label={`Show ${dateLabel(date, { dateStyle: "full" })}`}
                    >
                      <span>
                        {dateLabel(date, { weekday: "short" }).replace(
                          "Thu",
                          "Thur",
                        )}{" "}
                        {Number(date.slice(-2))}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="calendar-all-day" aria-label="All-day events">
                  <span className="calendar-all-day-label" />
                  {days.map((date) => (
                    <div className="calendar-all-day-cell" key={date}>
                      <button
                        className="calendar-all-day-create"
                        aria-label={`Create all-day event on ${date}`}
                        onClick={() => createEvent(date, 0, true)}
                      />
                      {eventsOn(date)
                        .filter((event) => event.allDay)
                        .map((event) => (
                          <button
                            key={event.id}
                            className={`calendar-all-day-event calendar-color-${event.color} ${event.end <= today ? "is-past" : ""}`}
                            onClick={() => openEvent(event)}
                            title={event.title}
                          >
                            {event.title}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="calendar-time-grid">
                <div className="calendar-time-axis">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <div key={hour}>
                      <span>
                        {preferences.timeFormat === "24 hour"
                          ? `${String(hour).padStart(2, "0")}:00`
                          : `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`}
                      </span>
                    </div>
                  ))}
                </div>
                {days.map((date) => {
                  const items = eventsOn(date)
                    .filter((event) => !event.allDay)
                    .map((event) => ({
                      event,
                      start: Math.max(
                        0,
                        (Date.parse(`${event.wallStart}Z`) -
                          dateValue(date).getTime()) /
                          60000,
                      ),
                      end: Math.min(
                        1440,
                        (Date.parse(`${event.wallEnd}Z`) -
                          dateValue(date).getTime()) /
                          60000,
                      ),
                      lane: 0,
                      lanes: 1,
                    }));
                  let group: typeof items = [],
                    laneEnds: number[] = [],
                    groupEnd = -1;
                  const finishGroup = () =>
                    group.forEach((item) => {
                      item.lanes = laneEnds.length;
                    });
                  for (const item of items) {
                    if (item.start >= groupEnd) {
                      finishGroup();
                      group = [];
                      laneEnds = [];
                      groupEnd = -1;
                    }
                    let lane = laneEnds.findIndex((end) => end <= item.start);
                    if (lane < 0) lane = laneEnds.length;
                    item.lane = lane;
                    laneEnds[lane] = item.end;
                    group.push(item);
                    groupEnd = Math.max(groupEnd, item.end);
                  }
                  finishGroup();
                  return (
                    <div className="calendar-day-column" key={date}>
                      {Array.from({ length: 24 }, (_, hour) => (
                        <button
                          key={hour}
                          className={`calendar-hour-slot ${hour < 8 || hour >= 18 ? "outside-hours" : ""}`}
                          aria-label={`Create event ${dateLabel(date, { weekday: "long", month: "long", day: "numeric" })} at ${hour}:00`}
                          onClick={(e) =>
                            createEvent(
                              date,
                              hour * 60 +
                                (e.detail &&
                                e.clientY -
                                  e.currentTarget.getBoundingClientRect().top >=
                                  HOUR_HEIGHT / 2
                                  ? 30
                                  : 0),
                            )
                          }
                        />
                      ))}
                      {items.map(({ event, start, end, lane, lanes }) => (
                        <button
                          key={event.id}
                          className={`calendar-event calendar-color-${event.color} ${end - start <= 30 ? "calendar-event-short" : ""} ${event.end <= now ? "is-past" : ""}`}
                          style={{
                            top: (start / 60) * HOUR_HEIGHT,
                            height: Math.max(
                              16,
                              ((end - start) / 60) * HOUR_HEIGHT - 1,
                            ),
                            left: `calc(${(lane / lanes) * 100}% + 1px)`,
                            width: `calc(${100 / lanes}% - 4px)`,
                          }}
                          title={`${event.title}\n${timeLabel(event.wallStart)} - ${timeLabel(event.wallEnd)}${event.location ? `\n${event.location}` : ""}`}
                          onClick={() => openEvent(event)}
                        >
                          <strong>{event.title}</strong>
                          {end - start > 30 && (
                            <span>
                              {timeLabel(event.wallStart)} -{" "}
                              {timeLabel(event.wallEnd)}
                            </span>
                          )}
                        </button>
                      ))}
                      {date === today && (
                        <div
                          className="calendar-now"
                          aria-label={`Current time: ${timeLabel(todayWall)}`}
                          style={{
                            top:
                              (Number(todayWall.slice(11, 13)) +
                                Number(todayWall.slice(14, 16)) / 60) *
                              HOUR_HEIGHT,
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <aside
        className="aux-owned-sidebar calendar-owned-sidebar"
        aria-label="Calendar sidebar"
      >
        <IconButton
          name="Close"
          title="Close calendar sidebar"
          className="aux-mobile-sidebar-close"
          onClick={() => setSidebarOpen(false)}
        />
        <div className="calendar-sidebar-content">
          <section className="calendar-mini-month">
            <header>
              <h2>
                {dateLabel(miniMonth, { month: "long", year: "numeric" })}
              </h2>
              <div>
                <IconButton
                  name="ChevronRight"
                  className="calendar-previous"
                  title="Previous month"
                  onClick={() => {
                    const value = dateValue(miniMonth);
                    value.setUTCMonth(value.getUTCMonth() - 1);
                    setMiniMonth(value.toISOString().slice(0, 10));
                  }}
                />
                <IconButton
                  name="ChevronRight"
                  title="Next month"
                  onClick={() => {
                    const value = dateValue(miniMonth);
                    value.setUTCMonth(value.getUTCMonth() + 1);
                    setMiniMonth(value.toISOString().slice(0, 10));
                  }}
                />
              </div>
            </header>
            <div className="calendar-mini-grid">
              <div className="calendar-mini-weekdays">
                {miniDays.slice(0, 7).map((date) => (
                  <span key={date}>
                    {dateLabel(date, { weekday: "narrow" })}
                  </span>
                ))}
              </div>
              <div className="calendar-mini-days">
                {miniDays.map((date) => (
                  <button
                    key={date}
                    className={`${date.slice(0, 7) !== miniMonth.slice(0, 7) ? "outside-month" : ""} ${date === day ? "selected" : ""}`}
                    aria-label={dateLabel(date, { dateStyle: "full" })}
                    aria-current={date === today ? "date" : undefined}
                    onClick={() => {
                      setDay(date);
                      setSidebarOpen(false);
                    }}
                  >
                    <span>{Number(date.slice(-2))}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
          <form
            className="calendar-meet"
            onSubmit={(e) => {
              e.preventDefault();
              if (meet.trim()) {
                createEvent(
                  day,
                  9 * 60,
                  false,
                  `Meeting with ${meet.trim()}`,
                  30,
                );
                setMeet("");
              }
            }}
          >
            <h3>
              <Icon name="UserPlus" />
              Meet
            </h3>
            <input
              aria-label="Meet name or email"
              placeholder="Enter name or email"
              value={meet}
              onChange={(e) => setMeet(e.target.value)}
            />
          </form>
          <section className="calendar-sidebar-section">
            <header>
              <button
                onClick={() => {
                  setSidebarTitle("");
                  setSidebarDialog("booking");
                }}
              >
                <Icon name="Calendar" />
                Booking Pages
              </button>
              <IconButton
                name="Plus"
                title="Create booking page"
                onClick={() => {
                  setSidebarTitle("");
                  setSidebarDialog("booking");
                }}
              />
            </header>
            {bookings.map((booking) => (
              <button
                className="calendar-booking-link"
                key={booking.id}
                onClick={() =>
                  createEvent(
                    day,
                    9 * 60,
                    false,
                    booking.title,
                    booking.duration,
                  )
                }
              >
                {booking.title}
                <span>{booking.duration} min</span>
              </button>
            ))}
          </section>
          <section className="calendar-sidebar-section">
            <header>
              <button
                onClick={() => setCalendarsExpanded(!calendarsExpanded)}
                aria-expanded={calendarsExpanded}
              >
                <Icon name="Calendar" />
                Calendars
              </button>
              <IconButton
                name="Plus"
                title="Add calendar"
                onClick={() => {
                  setSidebarTitle("");
                  setSidebarDialog("calendar");
                }}
              />
            </header>
            <button
              className="calendar-account-heading"
              onClick={() => setCalendarsExpanded(!calendarsExpanded)}
              aria-expanded={calendarsExpanded}
            >
              {account}
              <Icon name={calendarsExpanded ? "ChevronUp" : "ChevronDown"} />
            </button>
            {calendarsExpanded && (
              <div className="calendar-source-list">
                {sources.map((source) => (
                  <label key={source.id}>
                    <input
                      type="checkbox"
                      checked={source.checked}
                      onChange={(e) =>
                        changeSources(
                          sources.map((item) =>
                            item.id === source.id
                              ? { ...item, checked: e.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    <span>{source.name}</span>
                  </label>
                ))}
              </div>
            )}
          </section>
        </div>
        <footer className="aux-sidebar-footer">
          {onOpenSettings && (
            <IconButton
              name="Gear"
              title="Calendar settings"
              onClick={onOpenSettings}
            />
          )}
        </footer>
      </aside>
      {sidebarDialog && (
        <Modal
          label={
            sidebarDialog === "calendar"
              ? "Add calendar"
              : "Create booking page"
          }
          onClose={closeSidebarDialog}
          className="aux-editor calendar-sidebar-dialog"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!sidebarTitle.trim()) return;
              try {
                if (sidebarDialog === "calendar") {
                  const next = [
                    ...sources,
                    {
                      id: crypto.randomUUID(),
                      name: sidebarTitle.trim(),
                      checked: true,
                    },
                  ];
                  if (!writeSaved(`calendar-sources:${account}`, next))
                    throw new Error("Browser storage is unavailable.");
                  setSources(next);
                } else {
                  const next = [
                    ...bookings,
                    {
                      id: crypto.randomUUID(),
                      title: sidebarTitle.trim(),
                      duration: Number(bookingDuration),
                    },
                  ];
                  if (!writeSaved(`calendar-bookings:${account}`, next))
                    throw new Error("Browser storage is unavailable.");
                  setBookings(next);
                }
                closeSidebarDialog();
              } catch {
                setCalendarError(
                  "Could not save. Browser storage is unavailable.",
                );
              }
            }}
          >
            <div className="aux-editor-heading">
              <h2>
                {sidebarDialog === "calendar"
                  ? "Add calendar"
                  : "Create booking page"}
              </h2>
            </div>
            <div className="aux-editor-fields">
              <label className="calendar-sidebar-name">
                Name
                <input
                  aria-label={
                    sidebarDialog === "calendar"
                      ? "Calendar name"
                      : "Booking page name"
                  }
                  required
                  autoFocus
                  value={sidebarTitle}
                  onChange={(e) => setSidebarTitle(e.target.value)}
                />
              </label>
              {sidebarDialog === "booking" && (
                <label className="calendar-sidebar-name">
                  Duration
                  <select
                    value={bookingDuration}
                    onChange={(e) => setBookingDuration(e.target.value)}
                  >
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                  </select>
                </label>
              )}
              {calendarError && (
                <p className="aux-form-error" role="alert">
                  {calendarError}
                </p>
              )}
            </div>
            <footer className="aux-editor-footer">
              <button
                type="button"
                className="aux-button aux-cancel"
                onClick={closeSidebarDialog}
              >
                Cancel
              </button>
              <button className="aux-button aux-primary" type="submit">
                Create
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {editor && (
        <EventEditor
          event={editor}
          timezone={timezone}
          account={account}
          sources={sources}
          onClose={closeEditor}
          onSave={(event) => {
            saveEvents(
              event.id
                ? events.map((existing) =>
                    existing.id === event.id ? event : existing,
                  )
                : [...events, { ...event, id: crypto.randomUUID() }],
            );
            setDay(
              event.allDay
                ? event.start
                : wallTime(event.start, timezone).slice(0, 10),
            );
            closeEditor();
          }}
          onDelete={() => {
            saveEvents(events.filter((event) => event.id !== editor.id));
            closeEditor();
          }}
        />
      )}
    </section>
  );
}

function EventEditor({
  event,
  timezone,
  account,
  sources,
  onClose,
  onSave,
  onDelete,
}: {
  event: CalendarEvent;
  timezone: string;
  account: string;
  sources: CalendarSource[];
  onClose: () => void;
  onSave: (event: CalendarEvent) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(event.title);
  const [start, setStart] = useState(
    event.allDay ? event.start : wallTime(event.start, timezone),
  );
  const [end, setEnd] = useState(
    event.allDay ? addDays(event.end, -1) : wallTime(event.end, timezone),
  );
  const [allDay, setAllDay] = useState(event.allDay);
  const [location, setLocation] = useState(event.location);
  const [description, setDescription] = useState(event.description);
  const [color, setColor] = useState(event.color);
  const [calendar, setCalendar] = useState(event.calendar || account);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  function save(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Add an event title.");
    try {
      if (!start || !end) throw new Error("Enter a start and end date.");
      const from = allDay ? start : toInstant(start, timezone);
      const to = allDay ? addDays(end, 1) : toInstant(end, timezone);
      if (Date.parse(to) <= Date.parse(from))
        throw new Error("The end must be after the start.");
      onSave({
        ...event,
        title: title.trim(),
        start: from,
        end: to,
        allDay,
        location: location.trim(),
        description,
        color,
        calendar,
      });
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== "QuotaExceededError"
          ? cause.message
          : "Could not save this event. Browser storage may be full.",
      );
    }
  }
  return (
    <Modal
      label={event.id ? "Edit event" : "New event"}
      onClose={onClose}
      className="aux-editor calendar-editor"
    >
      <form onSubmit={save}>
        <div className="aux-editor-heading">
          <input
            className="aux-title-input"
            aria-label="Event title"
            placeholder="Add title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
          />
          <IconButton name="Close" title="Close event" onClick={onClose} />
        </div>
        <div className="aux-editor-fields">
          <div className="calendar-date-fields">
            <Icon name="Clock" size={16} />
            <div>
              <div className="calendar-date-range">
                <label>
                  Start
                  <input
                    aria-label="Event start"
                    type={allDay ? "date" : "datetime-local"}
                    value={start}
                    required
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label>
                  End
                  <input
                    aria-label="Event end"
                    type={allDay ? "date" : "datetime-local"}
                    value={end}
                    required
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </label>
              </div>
              <div className="calendar-date-options">
                <label>
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setAllDay(checked);
                      setStart(start.slice(0, 10) + (checked ? "" : "T09:00"));
                      setEnd(end.slice(0, 10) + (checked ? "" : "T10:00"));
                    }}
                  />
                  All day
                </label>
                <span>{timezone.replaceAll("_", " ")}</span>
              </div>
            </div>
          </div>
          <label className="aux-field-row">
            <Icon name="Link" />
            <input
              aria-label="Event location"
              placeholder="Add location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          <label className="aux-field-row aux-description-row">
            <Icon name="LinesThree" />
            <textarea
              aria-label="Event description"
              placeholder="Add description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="aux-field-row calendar-event-account">
            <Icon name="Calendar" />
            <select
              className="calendar-source-select"
              aria-label="Event calendar"
              value={calendar}
              onChange={(e) => setCalendar(e.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Event color"
              value={color}
              onChange={(e) =>
                setColor(e.target.value as CalendarEvent["color"])
              }
            >
              <option value="blue">Blue</option>
              <option value="violet">Violet</option>
              <option value="green">Green</option>
              <option value="ochre">Ochre</option>
            </select>
          </div>
          {error && (
            <p className="aux-form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="aux-editor-footer">
          {event.id &&
            (confirmDelete ? (
              <div className="aux-delete-confirm">
                <span>Delete event?</span>
                <button
                  type="button"
                  className="aux-button aux-danger"
                  onClick={() => {
                    try {
                      onDelete();
                    } catch {
                      setError(
                        "Could not delete this event. Browser storage is unavailable.",
                      );
                    }
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="aux-button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </button>
              </div>
            ) : (
              <IconButton
                name="Trash"
                title="Delete event"
                onClick={() => setConfirmDelete(true)}
              />
            ))}
          {!confirmDelete && (
            <>
              <button
                type="button"
                className="aux-button aux-cancel"
                onClick={onClose}
              >
                Cancel <Key>Esc</Key>
              </button>
              <button type="submit" className="aux-button aux-primary">
                Save
              </button>
            </>
          )}
        </footer>
      </form>
    </Modal>
  );
}
