// Generated from server OpenAPI; do not edit.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.17.1/node_modules/ajv-formats/dist/formats.js
var require_formats = __commonJS({
  "node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.17.1/node_modules/ajv-formats/dist/formats.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.formatNames = exports.fastFormats = exports.fullFormats = void 0;
    function fmtDef(validate, compare) {
      return { validate, compare };
    }
    exports.fullFormats = {
      // date: http://tools.ietf.org/html/rfc3339#section-5.6
      date: fmtDef(date, compareDate),
      // date-time: http://tools.ietf.org/html/rfc3339#section-5.6
      time: fmtDef(getTime(true), compareTime),
      "date-time": fmtDef(getDateTime(true), compareDateTime),
      "iso-time": fmtDef(getTime(), compareIsoTime),
      "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
      // duration: https://tools.ietf.org/html/rfc3339#appendix-A
      duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
      uri,
      "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
      // uri-template: https://tools.ietf.org/html/rfc6570
      "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
      // For the source: https://gist.github.com/dperini/729294
      // For test cases: https://mathiasbynens.be/demo/url-regex
      url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
      email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
      hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
      // optimized https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/9780596802837/ch07s16.html
      ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
      ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
      regex,
      // uuid: http://tools.ietf.org/html/rfc4122
      uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
      // JSON-pointer: https://tools.ietf.org/html/rfc6901
      // uri fragment: https://tools.ietf.org/html/rfc3986#appendix-A
      "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
      "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
      // relative JSON-pointer: http://tools.ietf.org/html/draft-luff-relative-json-pointer-00
      "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
      // the following formats are used by the openapi specification: https://spec.openapis.org/oas/v3.0.0#data-types
      // byte: https://github.com/miguelmota/is-base64
      byte,
      // signed 32 bit integer
      int32: { type: "number", validate: validateInt32 },
      // signed 64 bit integer
      int64: { type: "number", validate: validateInt64 },
      // C-type float
      float: { type: "number", validate: validateNumber },
      // C-type double
      double: { type: "number", validate: validateNumber },
      // hint to the UI to hide input strings
      password: true,
      // unchecked string payload
      binary: true
    };
    exports.fastFormats = {
      ...exports.fullFormats,
      date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
      time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
      "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
      "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
      "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
      // uri: https://github.com/mafintosh/is-my-json-valid/blob/master/formats.js
      uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
      "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
      // email (sources from jsen validator):
      // http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
      // http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'wilful violation')
      email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
    };
    exports.formatNames = Object.keys(exports.fullFormats);
    function isLeapYear(year) {
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }
    var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
    var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    function date(str) {
      const matches = DATE.exec(str);
      if (!matches)
        return false;
      const year = +matches[1];
      const month = +matches[2];
      const day = +matches[3];
      return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
    }
    function compareDate(d1, d2) {
      if (!(d1 && d2))
        return void 0;
      if (d1 > d2)
        return 1;
      if (d1 < d2)
        return -1;
      return 0;
    }
    var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
    function getTime(strictTimeZone) {
      return function time(str) {
        const matches = TIME.exec(str);
        if (!matches)
          return false;
        const hr = +matches[1];
        const min = +matches[2];
        const sec = +matches[3];
        const tz = matches[4];
        const tzSign = matches[5] === "-" ? -1 : 1;
        const tzH = +(matches[6] || 0);
        const tzM = +(matches[7] || 0);
        if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
          return false;
        if (hr <= 23 && min <= 59 && sec < 60)
          return true;
        const utcMin = min - tzM * tzSign;
        const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
        return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
      };
    }
    function compareTime(s1, s2) {
      if (!(s1 && s2))
        return void 0;
      const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
      const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
      if (!(t1 && t2))
        return void 0;
      return t1 - t2;
    }
    function compareIsoTime(t1, t2) {
      if (!(t1 && t2))
        return void 0;
      const a1 = TIME.exec(t1);
      const a2 = TIME.exec(t2);
      if (!(a1 && a2))
        return void 0;
      t1 = a1[1] + a1[2] + a1[3];
      t2 = a2[1] + a2[2] + a2[3];
      if (t1 > t2)
        return 1;
      if (t1 < t2)
        return -1;
      return 0;
    }
    var DATE_TIME_SEPARATOR = /t|\s/i;
    function getDateTime(strictTimeZone) {
      const time = getTime(strictTimeZone);
      return function date_time(str) {
        const dateTime = str.split(DATE_TIME_SEPARATOR);
        return dateTime.length === 2 && date(dateTime[0]) && time(dateTime[1]);
      };
    }
    function compareDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const d1 = new Date(dt1).valueOf();
      const d2 = new Date(dt2).valueOf();
      if (!(d1 && d2))
        return void 0;
      return d1 - d2;
    }
    function compareIsoDateTime(dt1, dt2) {
      if (!(dt1 && dt2))
        return void 0;
      const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
      const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
      const res = compareDate(d1, d2);
      if (res === void 0)
        return void 0;
      return res || compareTime(t1, t2);
    }
    var NOT_URI_FRAGMENT = /\/|:/;
    var URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
    function uri(str) {
      return NOT_URI_FRAGMENT.test(str) && URI.test(str);
    }
    var BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
    function byte(str) {
      BYTE.lastIndex = 0;
      return BYTE.test(str);
    }
    var MIN_INT32 = -(2 ** 31);
    var MAX_INT32 = 2 ** 31 - 1;
    function validateInt32(value) {
      return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
    }
    function validateInt64(value) {
      return Number.isInteger(value);
    }
    function validateNumber() {
      return true;
    }
    var Z_ANCHOR = /[^\\]\\Z/;
    function regex(str) {
      if (Z_ANCHOR.test(str))
        return false;
      try {
        new RegExp(str);
        return true;
      } catch (e) {
        return false;
      }
    }
  }
});

// validators.js
var validateForgetUserPath = validate20;
var formats0 = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function validate20(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate20.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.user_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/allOf/0/required", keyword: "required", params: { missingProperty: "user_id" }, message: "must have required property 'user_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "user_id")) {
        const err1 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.user_id !== void 0) {
      let data0 = data.user_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err2 = { instancePath: instancePath + "/user_id", schemaPath: "#/allOf/0/properties/user_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
      } else {
        const err3 = { instancePath: instancePath + "/user_id", schemaPath: "#/allOf/0/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
  } else {
    const err4 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate20.errors = vErrors;
  return errors === 0;
}
validate20.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateForgottenUser = validate21;
function validate21(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate21.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.user_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/ForgottenUser/required", keyword: "required", params: { missingProperty: "user_id" }, message: "must have required property 'user_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.forgotten === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/ForgottenUser/required", keyword: "required", params: { missingProperty: "forgotten" }, message: "must have required property 'forgotten'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "user_id" || key0 === "forgotten")) {
        const err2 = { instancePath, schemaPath: "#/components/schemas/ForgottenUser/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.user_id !== void 0) {
      let data0 = data.user_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err3 = { instancePath: instancePath + "/user_id", schemaPath: "#/components/schemas/ForgottenUser/properties/user_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      } else {
        const err4 = { instancePath: instancePath + "/user_id", schemaPath: "#/components/schemas/ForgottenUser/properties/user_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.forgotten !== void 0) {
      let data1 = data.forgotten;
      if (typeof data1 !== "boolean") {
        const err5 = { instancePath: instancePath + "/forgotten", schemaPath: "#/components/schemas/ForgottenUser/properties/forgotten/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
      if (true !== data1) {
        const err6 = { instancePath: instancePath + "/forgotten", schemaPath: "#/components/schemas/ForgottenUser/properties/forgotten/const", keyword: "const", params: { allowedValue: true }, message: "must be equal to constant" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
  } else {
    const err7 = { instancePath, schemaPath: "#/components/schemas/ForgottenUser/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err7];
    } else {
      vErrors.push(err7);
    }
    errors++;
  }
  validate21.errors = vErrors;
  return errors === 0;
}
validate21.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateOperation = validate22;
var schema35 = { "properties": { "operation_id": { "type": "string", "format": "uuid", "title": "Operation Id" }, "status": { "type": "string", "enum": ["processing", "completed", "failed"], "title": "Status" }, "source_id": { "type": "string", "title": "Source Id" }, "blob_id": { "anyOf": [{ "type": "string", "format": "uuid" }, { "type": "null" }], "title": "Blob Id" }, "result": { "anyOf": [{ "$ref": "#/components/schemas/SourceResult" }, { "type": "null" }] }, "error": { "anyOf": [{ "$ref": "#/components/schemas/OperationError" }, { "type": "null" }] } }, "additionalProperties": false, "type": "object", "required": ["operation_id", "status", "source_id", "blob_id", "result", "error"], "title": "Operation" };
function validate23(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate23.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operation_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "operation_id" }, message: "must have required property 'operation_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.status === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.blob_id === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.result === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "result" }, message: "must have required property 'result'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.error === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "error" }, message: "must have required property 'error'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "operation_id" || key0 === "status" || key0 === "source_id" || key0 === "blob_id" || key0 === "result" || key0 === "error")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.operation_id !== void 0) {
      let data0 = data.operation_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      let data1 = data.status;
      if (typeof data1 !== "string") {
        const err9 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
      if (!(data1 === "processing" || data1 === "completed" || data1 === "failed")) {
        const err10 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/enum", keyword: "enum", params: { allowedValues: schema35.properties.status.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      if (typeof data.source_id !== "string") {
        const err11 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.blob_id !== void 0) {
      let data3 = data.blob_id;
      const _errs9 = errors;
      let valid1 = false;
      const _errs10 = errors;
      if (typeof data3 === "string") {
        if (!formats0.test(data3)) {
          const err12 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      var _valid0 = _errs10 === errors;
      valid1 = valid1 || _valid0;
      const _errs12 = errors;
      if (data3 !== null) {
        const err14 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
      var _valid0 = _errs12 === errors;
      valid1 = valid1 || _valid0;
      if (!valid1) {
        const err15 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      } else {
        errors = _errs9;
        if (vErrors !== null) {
          if (_errs9) {
            vErrors.length = _errs9;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.result !== void 0) {
      let data4 = data.result;
      const _errs15 = errors;
      let valid2 = false;
      const _errs16 = errors;
      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
        if (data4.event_ids === void 0) {
          const err16 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/required", keyword: "required", params: { missingProperty: "event_ids" }, message: "must have required property 'event_ids'" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        if (data4.profile_ids === void 0) {
          const err17 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/required", keyword: "required", params: { missingProperty: "profile_ids" }, message: "must have required property 'profile_ids'" };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
        for (const key1 in data4) {
          if (!(key1 === "event_ids" || key1 === "profile_ids")) {
            const err18 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data4.event_ids !== void 0) {
          let data5 = data4.event_ids;
          if (Array.isArray(data5)) {
            const len0 = data5.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data6 = data5[i0];
              if (typeof data6 === "string") {
                if (!formats0.test(data6)) {
                  const err19 = { instancePath: instancePath + "/result/event_ids/" + i0, schemaPath: "#/components/schemas/SourceResult/properties/event_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err19];
                  } else {
                    vErrors.push(err19);
                  }
                  errors++;
                }
              } else {
                const err20 = { instancePath: instancePath + "/result/event_ids/" + i0, schemaPath: "#/components/schemas/SourceResult/properties/event_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err20];
                } else {
                  vErrors.push(err20);
                }
                errors++;
              }
            }
          } else {
            const err21 = { instancePath: instancePath + "/result/event_ids", schemaPath: "#/components/schemas/SourceResult/properties/event_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err21];
            } else {
              vErrors.push(err21);
            }
            errors++;
          }
        }
        if (data4.profile_ids !== void 0) {
          let data7 = data4.profile_ids;
          if (Array.isArray(data7)) {
            const len1 = data7.length;
            for (let i1 = 0; i1 < len1; i1++) {
              let data8 = data7[i1];
              if (typeof data8 === "string") {
                if (!formats0.test(data8)) {
                  const err22 = { instancePath: instancePath + "/result/profile_ids/" + i1, schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err22];
                  } else {
                    vErrors.push(err22);
                  }
                  errors++;
                }
              } else {
                const err23 = { instancePath: instancePath + "/result/profile_ids/" + i1, schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err23];
                } else {
                  vErrors.push(err23);
                }
                errors++;
              }
            }
          } else {
            const err24 = { instancePath: instancePath + "/result/profile_ids", schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err24];
            } else {
              vErrors.push(err24);
            }
            errors++;
          }
        }
      } else {
        const err25 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
      var _valid1 = _errs16 === errors;
      valid2 = valid2 || _valid1;
      const _errs28 = errors;
      if (data4 !== null) {
        const err26 = { instancePath: instancePath + "/result", schemaPath: "#/properties/result/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err26];
        } else {
          vErrors.push(err26);
        }
        errors++;
      }
      var _valid1 = _errs28 === errors;
      valid2 = valid2 || _valid1;
      if (!valid2) {
        const err27 = { instancePath: instancePath + "/result", schemaPath: "#/properties/result/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      } else {
        errors = _errs15;
        if (vErrors !== null) {
          if (_errs15) {
            vErrors.length = _errs15;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.error !== void 0) {
      let data9 = data.error;
      const _errs31 = errors;
      let valid9 = false;
      const _errs32 = errors;
      if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
        if (data9.code === void 0) {
          const err28 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/required", keyword: "required", params: { missingProperty: "code" }, message: "must have required property 'code'" };
          if (vErrors === null) {
            vErrors = [err28];
          } else {
            vErrors.push(err28);
          }
          errors++;
        }
        if (data9.retryable === void 0) {
          const err29 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/required", keyword: "required", params: { missingProperty: "retryable" }, message: "must have required property 'retryable'" };
          if (vErrors === null) {
            vErrors = [err29];
          } else {
            vErrors.push(err29);
          }
          errors++;
        }
        for (const key2 in data9) {
          if (!(key2 === "code" || key2 === "retryable")) {
            const err30 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key2 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err30];
            } else {
              vErrors.push(err30);
            }
            errors++;
          }
        }
        if (data9.code !== void 0) {
          if (typeof data9.code !== "string") {
            const err31 = { instancePath: instancePath + "/error/code", schemaPath: "#/components/schemas/OperationError/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err31];
            } else {
              vErrors.push(err31);
            }
            errors++;
          }
        }
        if (data9.retryable !== void 0) {
          if (typeof data9.retryable !== "boolean") {
            const err32 = { instancePath: instancePath + "/error/retryable", schemaPath: "#/components/schemas/OperationError/properties/retryable/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
            if (vErrors === null) {
              vErrors = [err32];
            } else {
              vErrors.push(err32);
            }
            errors++;
          }
        }
      } else {
        const err33 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
      var _valid2 = _errs32 === errors;
      valid9 = valid9 || _valid2;
      const _errs40 = errors;
      if (data9 !== null) {
        const err34 = { instancePath: instancePath + "/error", schemaPath: "#/properties/error/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err34];
        } else {
          vErrors.push(err34);
        }
        errors++;
      }
      var _valid2 = _errs40 === errors;
      valid9 = valid9 || _valid2;
      if (!valid9) {
        const err35 = { instancePath: instancePath + "/error", schemaPath: "#/properties/error/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err35];
        } else {
          vErrors.push(err35);
        }
        errors++;
      } else {
        errors = _errs31;
        if (vErrors !== null) {
          if (_errs31) {
            vErrors.length = _errs31;
          } else {
            vErrors = null;
          }
        }
      }
    }
  } else {
    const err36 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err36];
    } else {
      vErrors.push(err36);
    }
    errors++;
  }
  validate23.errors = vErrors;
  return errors === 0;
}
validate23.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate22(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate22.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate23(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate23.errors : vErrors.concat(validate23.errors);
    errors = vErrors.length;
  }
  validate22.errors = vErrors;
  return errors === 0;
}
validate22.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateImport = validate25;
var schema40 = { "properties": { "message_id": { "type": "string", "maxLength": 255, "minLength": 1, "title": "Message Id" }, "role": { "type": "string", "enum": ["user", "assistant", "system", "tool"], "title": "Role" }, "content": { "type": "string", "maxLength": 262144, "minLength": 1, "title": "Content" }, "occurred_at": { "type": "string", "format": "date-time", "title": "Occurred At" }, "time_zone": { "anyOf": [{ "type": "string", "maxLength": 100 }, { "type": "null" }], "title": "Time Zone" } }, "additionalProperties": false, "type": "object", "required": ["message_id", "role", "content", "occurred_at"], "title": "SourceMessage" };
var func1 = require_ucs2length().default;
var pattern4 = new RegExp("^[^/]+$", "u");
var formats12 = require_formats().fullFormats["date-time"];
function validate26(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate26.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.idempotency_key === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "idempotency_key" }, message: "must have required property 'idempotency_key'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.messages === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "messages" }, message: "must have required property 'messages'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "idempotency_key" || key0 === "source_id" || key0 === "messages" || key0 === "metadata")) {
        const err3 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.idempotency_key !== void 0) {
      let data0 = data.idempotency_key;
      if (typeof data0 === "string") {
        if (func1(data0) > 255) {
          const err4 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err5 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
        if (!pattern4.test(data0)) {
          const err6 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/pattern", keyword: "pattern", params: { pattern: "^[^/]+$" }, message: 'must match pattern "^[^/]+$"' };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/properties/idempotency_key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      let data1 = data.source_id;
      if (typeof data1 === "string") {
        if (func1(data1) > 255) {
          const err8 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        if (func1(data1) < 1) {
          const err9 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
        if (!pattern4.test(data1)) {
          const err10 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/pattern", keyword: "pattern", params: { pattern: "^[^/]+$" }, message: 'must match pattern "^[^/]+$"' };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.messages !== void 0) {
      let data2 = data.messages;
      if (Array.isArray(data2)) {
        if (data2.length > 1e3) {
          const err12 = { instancePath: instancePath + "/messages", schemaPath: "#/properties/messages/maxItems", keyword: "maxItems", params: { limit: 1e3 }, message: "must NOT have more than 1000 items" };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
        if (data2.length < 1) {
          const err13 = { instancePath: instancePath + "/messages", schemaPath: "#/properties/messages/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data3 = data2[i0];
          if (data3 && typeof data3 == "object" && !Array.isArray(data3)) {
            if (data3.message_id === void 0) {
              const err14 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/required", keyword: "required", params: { missingProperty: "message_id" }, message: "must have required property 'message_id'" };
              if (vErrors === null) {
                vErrors = [err14];
              } else {
                vErrors.push(err14);
              }
              errors++;
            }
            if (data3.role === void 0) {
              const err15 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/required", keyword: "required", params: { missingProperty: "role" }, message: "must have required property 'role'" };
              if (vErrors === null) {
                vErrors = [err15];
              } else {
                vErrors.push(err15);
              }
              errors++;
            }
            if (data3.content === void 0) {
              const err16 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
              if (vErrors === null) {
                vErrors = [err16];
              } else {
                vErrors.push(err16);
              }
              errors++;
            }
            if (data3.occurred_at === void 0) {
              const err17 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/required", keyword: "required", params: { missingProperty: "occurred_at" }, message: "must have required property 'occurred_at'" };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
            for (const key1 in data3) {
              if (!(key1 === "message_id" || key1 === "role" || key1 === "content" || key1 === "occurred_at" || key1 === "time_zone")) {
                const err18 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err18];
                } else {
                  vErrors.push(err18);
                }
                errors++;
              }
            }
            if (data3.message_id !== void 0) {
              let data4 = data3.message_id;
              if (typeof data4 === "string") {
                if (func1(data4) > 255) {
                  const err19 = { instancePath: instancePath + "/messages/" + i0 + "/message_id", schemaPath: "#/components/schemas/SourceMessage/properties/message_id/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
                  if (vErrors === null) {
                    vErrors = [err19];
                  } else {
                    vErrors.push(err19);
                  }
                  errors++;
                }
                if (func1(data4) < 1) {
                  const err20 = { instancePath: instancePath + "/messages/" + i0 + "/message_id", schemaPath: "#/components/schemas/SourceMessage/properties/message_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err20];
                  } else {
                    vErrors.push(err20);
                  }
                  errors++;
                }
              } else {
                const err21 = { instancePath: instancePath + "/messages/" + i0 + "/message_id", schemaPath: "#/components/schemas/SourceMessage/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
            }
            if (data3.role !== void 0) {
              let data5 = data3.role;
              if (typeof data5 !== "string") {
                const err22 = { instancePath: instancePath + "/messages/" + i0 + "/role", schemaPath: "#/components/schemas/SourceMessage/properties/role/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
              if (!(data5 === "user" || data5 === "assistant" || data5 === "system" || data5 === "tool")) {
                const err23 = { instancePath: instancePath + "/messages/" + i0 + "/role", schemaPath: "#/components/schemas/SourceMessage/properties/role/enum", keyword: "enum", params: { allowedValues: schema40.properties.role.enum }, message: "must be equal to one of the allowed values" };
                if (vErrors === null) {
                  vErrors = [err23];
                } else {
                  vErrors.push(err23);
                }
                errors++;
              }
            }
            if (data3.content !== void 0) {
              let data6 = data3.content;
              if (typeof data6 === "string") {
                if (func1(data6) > 262144) {
                  const err24 = { instancePath: instancePath + "/messages/" + i0 + "/content", schemaPath: "#/components/schemas/SourceMessage/properties/content/maxLength", keyword: "maxLength", params: { limit: 262144 }, message: "must NOT have more than 262144 characters" };
                  if (vErrors === null) {
                    vErrors = [err24];
                  } else {
                    vErrors.push(err24);
                  }
                  errors++;
                }
                if (func1(data6) < 1) {
                  const err25 = { instancePath: instancePath + "/messages/" + i0 + "/content", schemaPath: "#/components/schemas/SourceMessage/properties/content/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err25];
                  } else {
                    vErrors.push(err25);
                  }
                  errors++;
                }
              } else {
                const err26 = { instancePath: instancePath + "/messages/" + i0 + "/content", schemaPath: "#/components/schemas/SourceMessage/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
            }
            if (data3.occurred_at !== void 0) {
              let data7 = data3.occurred_at;
              if (typeof data7 === "string") {
                if (!formats12.validate(data7)) {
                  const err27 = { instancePath: instancePath + "/messages/" + i0 + "/occurred_at", schemaPath: "#/components/schemas/SourceMessage/properties/occurred_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err27];
                  } else {
                    vErrors.push(err27);
                  }
                  errors++;
                }
              } else {
                const err28 = { instancePath: instancePath + "/messages/" + i0 + "/occurred_at", schemaPath: "#/components/schemas/SourceMessage/properties/occurred_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err28];
                } else {
                  vErrors.push(err28);
                }
                errors++;
              }
            }
            if (data3.time_zone !== void 0) {
              let data8 = data3.time_zone;
              const _errs21 = errors;
              let valid5 = false;
              const _errs22 = errors;
              if (typeof data8 === "string") {
                if (func1(data8) > 100) {
                  const err29 = { instancePath: instancePath + "/messages/" + i0 + "/time_zone", schemaPath: "#/components/schemas/SourceMessage/properties/time_zone/anyOf/0/maxLength", keyword: "maxLength", params: { limit: 100 }, message: "must NOT have more than 100 characters" };
                  if (vErrors === null) {
                    vErrors = [err29];
                  } else {
                    vErrors.push(err29);
                  }
                  errors++;
                }
              } else {
                const err30 = { instancePath: instancePath + "/messages/" + i0 + "/time_zone", schemaPath: "#/components/schemas/SourceMessage/properties/time_zone/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err30];
                } else {
                  vErrors.push(err30);
                }
                errors++;
              }
              var _valid0 = _errs22 === errors;
              valid5 = valid5 || _valid0;
              const _errs24 = errors;
              if (data8 !== null) {
                const err31 = { instancePath: instancePath + "/messages/" + i0 + "/time_zone", schemaPath: "#/components/schemas/SourceMessage/properties/time_zone/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err31];
                } else {
                  vErrors.push(err31);
                }
                errors++;
              }
              var _valid0 = _errs24 === errors;
              valid5 = valid5 || _valid0;
              if (!valid5) {
                const err32 = { instancePath: instancePath + "/messages/" + i0 + "/time_zone", schemaPath: "#/components/schemas/SourceMessage/properties/time_zone/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err32];
                } else {
                  vErrors.push(err32);
                }
                errors++;
              } else {
                errors = _errs21;
                if (vErrors !== null) {
                  if (_errs21) {
                    vErrors.length = _errs21;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
          } else {
            const err33 = { instancePath: instancePath + "/messages/" + i0, schemaPath: "#/components/schemas/SourceMessage/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err33];
            } else {
              vErrors.push(err33);
            }
            errors++;
          }
        }
      } else {
        const err34 = { instancePath: instancePath + "/messages", schemaPath: "#/properties/messages/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err34];
        } else {
          vErrors.push(err34);
        }
        errors++;
      }
    }
    if (data.metadata !== void 0) {
      let data9 = data.metadata;
      if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
      } else {
        const err35 = { instancePath: instancePath + "/metadata", schemaPath: "#/properties/metadata/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err35];
        } else {
          vErrors.push(err35);
        }
        errors++;
      }
    }
  } else {
    const err36 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err36];
    } else {
      vErrors.push(err36);
    }
    errors++;
  }
  validate26.errors = vErrors;
  return errors === 0;
}
validate26.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate25(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate25.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate26(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate26.errors : vErrors.concat(validate26.errors);
    errors = vErrors.length;
  }
  validate25.errors = vErrors;
  return errors === 0;
}
validate25.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateBlob = validate28;
var schema42 = { "properties": { "blob_id": { "type": "string", "format": "uuid", "title": "Blob Id" }, "source_id": { "type": "string", "title": "Source Id" }, "status": { "type": "string", "enum": ["processing", "failed", "active", "retracted", "rebuilding"], "title": "Status" }, "message_ids": { "items": { "type": "string" }, "type": "array", "title": "Message Ids" }, "event_ids": { "items": { "type": "string", "format": "uuid" }, "type": "array", "title": "Event Ids" }, "created_at": { "type": "string", "format": "date-time", "title": "Created At" } }, "additionalProperties": false, "type": "object", "required": ["blob_id", "source_id", "status", "message_ids", "event_ids", "created_at"], "title": "Blob" };
function validate28(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate28.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.blob_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.status === void 0) {
      const err2 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.message_ids === void 0) {
      const err3 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "message_ids" }, message: "must have required property 'message_ids'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.event_ids === void 0) {
      const err4 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "event_ids" }, message: "must have required property 'event_ids'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err5 = { instancePath, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "blob_id" || key0 === "source_id" || key0 === "status" || key0 === "message_ids" || key0 === "event_ids" || key0 === "created_at")) {
        const err6 = { instancePath, schemaPath: "#/components/schemas/Blob/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.blob_id !== void 0) {
      let data0 = data.blob_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/blob_id", schemaPath: "#/components/schemas/Blob/properties/blob_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/blob_id", schemaPath: "#/components/schemas/Blob/properties/blob_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      if (typeof data.source_id !== "string") {
        const err9 = { instancePath: instancePath + "/source_id", schemaPath: "#/components/schemas/Blob/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      let data2 = data.status;
      if (typeof data2 !== "string") {
        const err10 = { instancePath: instancePath + "/status", schemaPath: "#/components/schemas/Blob/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      if (!(data2 === "processing" || data2 === "failed" || data2 === "active" || data2 === "retracted" || data2 === "rebuilding")) {
        const err11 = { instancePath: instancePath + "/status", schemaPath: "#/components/schemas/Blob/properties/status/enum", keyword: "enum", params: { allowedValues: schema42.properties.status.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.message_ids !== void 0) {
      let data3 = data.message_ids;
      if (Array.isArray(data3)) {
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (typeof data3[i0] !== "string") {
            const err12 = { instancePath: instancePath + "/message_ids/" + i0, schemaPath: "#/components/schemas/Blob/properties/message_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err12];
            } else {
              vErrors.push(err12);
            }
            errors++;
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/message_ids", schemaPath: "#/components/schemas/Blob/properties/message_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.event_ids !== void 0) {
      let data5 = data.event_ids;
      if (Array.isArray(data5)) {
        const len1 = data5.length;
        for (let i1 = 0; i1 < len1; i1++) {
          let data6 = data5[i1];
          if (typeof data6 === "string") {
            if (!formats0.test(data6)) {
              const err14 = { instancePath: instancePath + "/event_ids/" + i1, schemaPath: "#/components/schemas/Blob/properties/event_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
              if (vErrors === null) {
                vErrors = [err14];
              } else {
                vErrors.push(err14);
              }
              errors++;
            }
          } else {
            const err15 = { instancePath: instancePath + "/event_ids/" + i1, schemaPath: "#/components/schemas/Blob/properties/event_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err15];
            } else {
              vErrors.push(err15);
            }
            errors++;
          }
        }
      } else {
        const err16 = { instancePath: instancePath + "/event_ids", schemaPath: "#/components/schemas/Blob/properties/event_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.created_at !== void 0) {
      let data7 = data.created_at;
      if (typeof data7 === "string") {
        if (!formats12.validate(data7)) {
          const err17 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/Blob/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
      } else {
        const err18 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/Blob/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
  } else {
    const err19 = { instancePath, schemaPath: "#/components/schemas/Blob/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err19];
    } else {
      vErrors.push(err19);
    }
    errors++;
  }
  validate28.errors = vErrors;
  return errors === 0;
}
validate28.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateMessageDeletion = validate29;
function validate29(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate29.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.idempotency_key === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/DeleteMessages/required", keyword: "required", params: { missingProperty: "idempotency_key" }, message: "must have required property 'idempotency_key'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.message_ids === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/DeleteMessages/required", keyword: "required", params: { missingProperty: "message_ids" }, message: "must have required property 'message_ids'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "idempotency_key" || key0 === "message_ids")) {
        const err2 = { instancePath, schemaPath: "#/components/schemas/DeleteMessages/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.idempotency_key !== void 0) {
      let data0 = data.idempotency_key;
      if (typeof data0 === "string") {
        if (func1(data0) > 255) {
          const err3 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/components/schemas/DeleteMessages/properties/idempotency_key/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err4 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/components/schemas/DeleteMessages/properties/idempotency_key/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
        if (!pattern4.test(data0)) {
          const err5 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/components/schemas/DeleteMessages/properties/idempotency_key/pattern", keyword: "pattern", params: { pattern: "^[^/]+$" }, message: 'must match pattern "^[^/]+$"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/idempotency_key", schemaPath: "#/components/schemas/DeleteMessages/properties/idempotency_key/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.message_ids !== void 0) {
      let data1 = data.message_ids;
      if (Array.isArray(data1)) {
        if (data1.length > 1e3) {
          const err7 = { instancePath: instancePath + "/message_ids", schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/maxItems", keyword: "maxItems", params: { limit: 1e3 }, message: "must NOT have more than 1000 items" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
        if (data1.length < 1) {
          const err8 = { instancePath: instancePath + "/message_ids", schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
        const len0 = data1.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data2 = data1[i0];
          if (typeof data2 === "string") {
            if (func1(data2) > 255) {
              const err9 = { instancePath: instancePath + "/message_ids/" + i0, schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/items/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
              if (vErrors === null) {
                vErrors = [err9];
              } else {
                vErrors.push(err9);
              }
              errors++;
            }
            if (func1(data2) < 1) {
              const err10 = { instancePath: instancePath + "/message_ids/" + i0, schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/items/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
              if (vErrors === null) {
                vErrors = [err10];
              } else {
                vErrors.push(err10);
              }
              errors++;
            }
          } else {
            const err11 = { instancePath: instancePath + "/message_ids/" + i0, schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err11];
            } else {
              vErrors.push(err11);
            }
            errors++;
          }
        }
      } else {
        const err12 = { instancePath: instancePath + "/message_ids", schemaPath: "#/components/schemas/DeleteMessages/properties/message_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
  } else {
    const err13 = { instancePath, schemaPath: "#/components/schemas/DeleteMessages/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err13];
    } else {
      vErrors.push(err13);
    }
    errors++;
  }
  validate29.errors = vErrors;
  return errors === 0;
}
validate29.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateSources = validate30;
function validate31(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate31.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.sources === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "sources" }, message: "must have required property 'sources'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "sources")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.sources !== void 0) {
      let data0 = data.sources;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.source_id === void 0) {
              const err2 = { instancePath: instancePath + "/sources/" + i0, schemaPath: "#/components/schemas/SourceSummary/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
            if (data1.legacy === void 0) {
              const err3 = { instancePath: instancePath + "/sources/" + i0, schemaPath: "#/components/schemas/SourceSummary/required", keyword: "required", params: { missingProperty: "legacy" }, message: "must have required property 'legacy'" };
              if (vErrors === null) {
                vErrors = [err3];
              } else {
                vErrors.push(err3);
              }
              errors++;
            }
            if (data1.created_at === void 0) {
              const err4 = { instancePath: instancePath + "/sources/" + i0, schemaPath: "#/components/schemas/SourceSummary/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            for (const key1 in data1) {
              if (!(key1 === "source_id" || key1 === "legacy" || key1 === "created_at")) {
                const err5 = { instancePath: instancePath + "/sources/" + i0, schemaPath: "#/components/schemas/SourceSummary/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err5];
                } else {
                  vErrors.push(err5);
                }
                errors++;
              }
            }
            if (data1.source_id !== void 0) {
              if (typeof data1.source_id !== "string") {
                const err6 = { instancePath: instancePath + "/sources/" + i0 + "/source_id", schemaPath: "#/components/schemas/SourceSummary/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err6];
                } else {
                  vErrors.push(err6);
                }
                errors++;
              }
            }
            if (data1.legacy !== void 0) {
              if (typeof data1.legacy !== "boolean") {
                const err7 = { instancePath: instancePath + "/sources/" + i0 + "/legacy", schemaPath: "#/components/schemas/SourceSummary/properties/legacy/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
                if (vErrors === null) {
                  vErrors = [err7];
                } else {
                  vErrors.push(err7);
                }
                errors++;
              }
            }
            if (data1.created_at !== void 0) {
              let data4 = data1.created_at;
              if (typeof data4 === "string") {
                if (!formats12.validate(data4)) {
                  const err8 = { instancePath: instancePath + "/sources/" + i0 + "/created_at", schemaPath: "#/components/schemas/SourceSummary/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err8];
                  } else {
                    vErrors.push(err8);
                  }
                  errors++;
                }
              } else {
                const err9 = { instancePath: instancePath + "/sources/" + i0 + "/created_at", schemaPath: "#/components/schemas/SourceSummary/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err9];
                } else {
                  vErrors.push(err9);
                }
                errors++;
              }
            }
          } else {
            const err10 = { instancePath: instancePath + "/sources/" + i0, schemaPath: "#/components/schemas/SourceSummary/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err10];
            } else {
              vErrors.push(err10);
            }
            errors++;
          }
        }
      } else {
        const err11 = { instancePath: instancePath + "/sources", schemaPath: "#/properties/sources/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
  } else {
    const err12 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err12];
    } else {
      vErrors.push(err12);
    }
    errors++;
  }
  validate31.errors = vErrors;
  return errors === 0;
}
validate31.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate30(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate30.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate31(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate31.errors : vErrors.concat(validate31.errors);
    errors = vErrors.length;
  }
  validate30.errors = vErrors;
  return errors === 0;
}
validate30.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateSource = validate33;
var schema49 = { "properties": { "source_id": { "type": "string", "title": "Source Id" }, "legacy": { "type": "boolean", "title": "Legacy" }, "created_at": { "type": "string", "format": "date-time", "title": "Created At" }, "message_ids": { "items": { "type": "string" }, "type": "array", "title": "Message Ids" }, "deleted_message_ids": { "items": { "type": "string" }, "type": "array", "title": "Deleted Message Ids" }, "blobs": { "items": { "$ref": "#/components/schemas/Blob" }, "type": "array", "title": "Blobs" }, "evidence": { "items": { "$ref": "#/components/schemas/Evidence" }, "type": "array", "title": "Evidence" }, "next_message_offset": { "anyOf": [{ "type": "integer" }, { "type": "null" }], "title": "Next Message Offset" }, "next_blob_offset": { "anyOf": [{ "type": "integer" }, { "type": "null" }], "title": "Next Blob Offset" }, "next_evidence_offset": { "anyOf": [{ "type": "integer" }, { "type": "null" }], "title": "Next Evidence Offset" } }, "additionalProperties": false, "type": "object", "required": ["source_id", "legacy", "created_at", "message_ids", "deleted_message_ids", "blobs", "evidence", "next_message_offset", "next_blob_offset", "next_evidence_offset"], "title": "Source" };
var func14 = Object.prototype.hasOwnProperty;
var schema52 = { "properties": { "start": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }], "title": "Start" }, "end": { "anyOf": [{ "type": "string", "format": "date" }, { "type": "null" }], "title": "End" }, "precision": { "type": "string", "enum": ["year", "month", "day", "range", "unknown"], "title": "Precision" }, "evidence": { "items": { "$ref": "#/components/schemas/TimeEvidence" }, "type": "array", "maxItems": 20, "minItems": 1, "title": "Evidence" } }, "additionalProperties": false, "type": "object", "required": ["start", "end", "precision", "evidence"], "title": "EventTime" };
var formats34 = require_formats().fullFormats.date;
function validate36(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate36.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.start === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "start" }, message: "must have required property 'start'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.end === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "end" }, message: "must have required property 'end'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.precision === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "precision" }, message: "must have required property 'precision'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.evidence === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "evidence" }, message: "must have required property 'evidence'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "start" || key0 === "end" || key0 === "precision" || key0 === "evidence")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.start !== void 0) {
      let data0 = data.start;
      const _errs3 = errors;
      let valid1 = false;
      const _errs4 = errors;
      if (typeof data0 === "string") {
        if (!formats34.validate(data0)) {
          const err5 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/0/format", keyword: "format", params: { format: "date" }, message: 'must match format "date"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
      var _valid0 = _errs4 === errors;
      valid1 = valid1 || _valid0;
      const _errs6 = errors;
      if (data0 !== null) {
        const err7 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      var _valid0 = _errs6 === errors;
      valid1 = valid1 || _valid0;
      if (!valid1) {
        const err8 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      } else {
        errors = _errs3;
        if (vErrors !== null) {
          if (_errs3) {
            vErrors.length = _errs3;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.end !== void 0) {
      let data1 = data.end;
      const _errs9 = errors;
      let valid2 = false;
      const _errs10 = errors;
      if (typeof data1 === "string") {
        if (!formats34.validate(data1)) {
          const err9 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/0/format", keyword: "format", params: { format: "date" }, message: 'must match format "date"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      var _valid1 = _errs10 === errors;
      valid2 = valid2 || _valid1;
      const _errs12 = errors;
      if (data1 !== null) {
        const err11 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      var _valid1 = _errs12 === errors;
      valid2 = valid2 || _valid1;
      if (!valid2) {
        const err12 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      } else {
        errors = _errs9;
        if (vErrors !== null) {
          if (_errs9) {
            vErrors.length = _errs9;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.precision !== void 0) {
      let data2 = data.precision;
      if (typeof data2 !== "string") {
        const err13 = { instancePath: instancePath + "/precision", schemaPath: "#/properties/precision/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      if (!(data2 === "year" || data2 === "month" || data2 === "day" || data2 === "range" || data2 === "unknown")) {
        const err14 = { instancePath: instancePath + "/precision", schemaPath: "#/properties/precision/enum", keyword: "enum", params: { allowedValues: schema52.properties.precision.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.evidence !== void 0) {
      let data3 = data.evidence;
      if (Array.isArray(data3)) {
        if (data3.length > 20) {
          const err15 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/maxItems", keyword: "maxItems", params: { limit: 20 }, message: "must NOT have more than 20 items" };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
        if (data3.length < 1) {
          const err16 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data4 = data3[i0];
          if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
            if (data4.message_id === void 0) {
              const err17 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/required", keyword: "required", params: { missingProperty: "message_id" }, message: "must have required property 'message_id'" };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
            if (data4.expression === void 0) {
              const err18 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/required", keyword: "required", params: { missingProperty: "expression" }, message: "must have required property 'expression'" };
              if (vErrors === null) {
                vErrors = [err18];
              } else {
                vErrors.push(err18);
              }
              errors++;
            }
            for (const key1 in data4) {
              if (!(key1 === "message_id" || key1 === "expression")) {
                const err19 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err19];
                } else {
                  vErrors.push(err19);
                }
                errors++;
              }
            }
            if (data4.message_id !== void 0) {
              let data5 = data4.message_id;
              if (typeof data5 === "string") {
                if (func1(data5) > 255) {
                  const err20 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
                  if (vErrors === null) {
                    vErrors = [err20];
                  } else {
                    vErrors.push(err20);
                  }
                  errors++;
                }
                if (func1(data5) < 1) {
                  const err21 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err21];
                  } else {
                    vErrors.push(err21);
                  }
                  errors++;
                }
              } else {
                const err22 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
            }
            if (data4.expression !== void 0) {
              let data6 = data4.expression;
              if (typeof data6 === "string") {
                if (func1(data6) > 1024) {
                  const err23 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/maxLength", keyword: "maxLength", params: { limit: 1024 }, message: "must NOT have more than 1024 characters" };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
                if (func1(data6) < 1) {
                  const err24 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err24];
                  } else {
                    vErrors.push(err24);
                  }
                  errors++;
                }
              } else {
                const err25 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
          } else {
            const err26 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err26];
            } else {
              vErrors.push(err26);
            }
            errors++;
          }
        }
      } else {
        const err27 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      }
    }
  } else {
    const err28 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err28];
    } else {
      vErrors.push(err28);
    }
    errors++;
  }
  validate36.errors = vErrors;
  return errors === 0;
}
validate36.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate35(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate35.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.fact_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "fact_id" }, message: "must have required property 'fact_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.blob_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.content === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.topic === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.sub_topic === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.support_groups === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "support_groups" }, message: "must have required property 'support_groups'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "fact_id" || key0 === "blob_id" || key0 === "content" || key0 === "topic" || key0 === "sub_topic" || key0 === "support_groups" || key0 === "event_time" || key0 === "source_messages")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.fact_id !== void 0) {
      let data0 = data.fact_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/fact_id", schemaPath: "#/properties/fact_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/fact_id", schemaPath: "#/properties/fact_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.blob_id !== void 0) {
      let data1 = data.blob_id;
      if (typeof data1 === "string") {
        if (!formats0.test(data1)) {
          const err9 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.content !== void 0) {
      if (typeof data.content !== "string") {
        const err11 = { instancePath: instancePath + "/content", schemaPath: "#/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.topic !== void 0) {
      if (typeof data.topic !== "string") {
        const err12 = { instancePath: instancePath + "/topic", schemaPath: "#/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.sub_topic !== void 0) {
      if (typeof data.sub_topic !== "string") {
        const err13 = { instancePath: instancePath + "/sub_topic", schemaPath: "#/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.support_groups !== void 0) {
      let data5 = data.support_groups;
      if (Array.isArray(data5)) {
        const len0 = data5.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data6 = data5[i0];
          if (Array.isArray(data6)) {
            const len1 = data6.length;
            for (let i1 = 0; i1 < len1; i1++) {
              if (typeof data6[i1] !== "string") {
                const err14 = { instancePath: instancePath + "/support_groups/" + i0 + "/" + i1, schemaPath: "#/properties/support_groups/items/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err14];
                } else {
                  vErrors.push(err14);
                }
                errors++;
              }
            }
          } else {
            const err15 = { instancePath: instancePath + "/support_groups/" + i0, schemaPath: "#/properties/support_groups/items/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err15];
            } else {
              vErrors.push(err15);
            }
            errors++;
          }
        }
      } else {
        const err16 = { instancePath: instancePath + "/support_groups", schemaPath: "#/properties/support_groups/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.event_time !== void 0) {
      let data8 = data.event_time;
      const _errs19 = errors;
      let valid5 = false;
      const _errs20 = errors;
      if (!validate36(data8, { instancePath: instancePath + "/event_time", parentData: data, parentDataProperty: "event_time", rootData, dynamicAnchors })) {
        vErrors = vErrors === null ? validate36.errors : vErrors.concat(validate36.errors);
        errors = vErrors.length;
      }
      var _valid0 = _errs20 === errors;
      valid5 = valid5 || _valid0;
      const _errs21 = errors;
      if (data8 !== null) {
        const err17 = { instancePath: instancePath + "/event_time", schemaPath: "#/properties/event_time/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      var _valid0 = _errs21 === errors;
      valid5 = valid5 || _valid0;
      if (!valid5) {
        const err18 = { instancePath: instancePath + "/event_time", schemaPath: "#/properties/event_time/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      } else {
        errors = _errs19;
        if (vErrors !== null) {
          if (_errs19) {
            vErrors.length = _errs19;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.source_messages !== void 0) {
      let data9 = data.source_messages;
      if (Array.isArray(data9)) {
        const len2 = data9.length;
        for (let i2 = 0; i2 < len2; i2++) {
          let data10 = data9[i2];
          if (data10 && typeof data10 == "object" && !Array.isArray(data10)) {
            if (data10.message_id === void 0) {
              const err19 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/required", keyword: "required", params: { missingProperty: "message_id" }, message: "must have required property 'message_id'" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
            if (data10.recorded_at === void 0) {
              const err20 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/required", keyword: "required", params: { missingProperty: "recorded_at" }, message: "must have required property 'recorded_at'" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            for (const key1 in data10) {
              if (!(key1 === "message_id" || key1 === "recorded_at" || key1 === "time_zone")) {
                const err21 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
            }
            if (data10.message_id !== void 0) {
              if (typeof data10.message_id !== "string") {
                const err22 = { instancePath: instancePath + "/source_messages/" + i2 + "/message_id", schemaPath: "#/components/schemas/SourceObservation/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
            }
            if (data10.recorded_at !== void 0) {
              let data12 = data10.recorded_at;
              if (typeof data12 === "string") {
                if (!formats12.validate(data12)) {
                  const err23 = { instancePath: instancePath + "/source_messages/" + i2 + "/recorded_at", schemaPath: "#/components/schemas/SourceObservation/properties/recorded_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
              } else {
                const err24 = { instancePath: instancePath + "/source_messages/" + i2 + "/recorded_at", schemaPath: "#/components/schemas/SourceObservation/properties/recorded_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
            }
            if (data10.time_zone !== void 0) {
              let data13 = data10.time_zone;
              const _errs34 = errors;
              let valid10 = false;
              const _errs35 = errors;
              if (typeof data13 !== "string") {
                const err25 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
              var _valid1 = _errs35 === errors;
              valid10 = valid10 || _valid1;
              const _errs37 = errors;
              if (data13 !== null) {
                const err26 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
              var _valid1 = _errs37 === errors;
              valid10 = valid10 || _valid1;
              if (!valid10) {
                const err27 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err27];
                } else {
                  vErrors.push(err27);
                }
                errors++;
              } else {
                errors = _errs34;
                if (vErrors !== null) {
                  if (_errs34) {
                    vErrors.length = _errs34;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
          } else {
            const err28 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
        }
      } else {
        const err29 = { instancePath: instancePath + "/source_messages", schemaPath: "#/properties/source_messages/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
  } else {
    const err30 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err30];
    } else {
      vErrors.push(err30);
    }
    errors++;
  }
  validate35.errors = vErrors;
  return errors === 0;
}
validate35.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate34(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate34.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.source_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.legacy === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "legacy" }, message: "must have required property 'legacy'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.message_ids === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "message_ids" }, message: "must have required property 'message_ids'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.deleted_message_ids === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "deleted_message_ids" }, message: "must have required property 'deleted_message_ids'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.blobs === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blobs" }, message: "must have required property 'blobs'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.evidence === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "evidence" }, message: "must have required property 'evidence'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    if (data.next_message_offset === void 0) {
      const err7 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "next_message_offset" }, message: "must have required property 'next_message_offset'" };
      if (vErrors === null) {
        vErrors = [err7];
      } else {
        vErrors.push(err7);
      }
      errors++;
    }
    if (data.next_blob_offset === void 0) {
      const err8 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "next_blob_offset" }, message: "must have required property 'next_blob_offset'" };
      if (vErrors === null) {
        vErrors = [err8];
      } else {
        vErrors.push(err8);
      }
      errors++;
    }
    if (data.next_evidence_offset === void 0) {
      const err9 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "next_evidence_offset" }, message: "must have required property 'next_evidence_offset'" };
      if (vErrors === null) {
        vErrors = [err9];
      } else {
        vErrors.push(err9);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!func14.call(schema49.properties, key0)) {
        const err10 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      if (typeof data.source_id !== "string") {
        const err11 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.legacy !== void 0) {
      if (typeof data.legacy !== "boolean") {
        const err12 = { instancePath: instancePath + "/legacy", schemaPath: "#/properties/legacy/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.created_at !== void 0) {
      let data2 = data.created_at;
      if (typeof data2 === "string") {
        if (!formats12.validate(data2)) {
          const err13 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      } else {
        const err14 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.message_ids !== void 0) {
      let data3 = data.message_ids;
      if (Array.isArray(data3)) {
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (typeof data3[i0] !== "string") {
            const err15 = { instancePath: instancePath + "/message_ids/" + i0, schemaPath: "#/properties/message_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err15];
            } else {
              vErrors.push(err15);
            }
            errors++;
          }
        }
      } else {
        const err16 = { instancePath: instancePath + "/message_ids", schemaPath: "#/properties/message_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.deleted_message_ids !== void 0) {
      let data5 = data.deleted_message_ids;
      if (Array.isArray(data5)) {
        const len1 = data5.length;
        for (let i1 = 0; i1 < len1; i1++) {
          if (typeof data5[i1] !== "string") {
            const err17 = { instancePath: instancePath + "/deleted_message_ids/" + i1, schemaPath: "#/properties/deleted_message_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err17];
            } else {
              vErrors.push(err17);
            }
            errors++;
          }
        }
      } else {
        const err18 = { instancePath: instancePath + "/deleted_message_ids", schemaPath: "#/properties/deleted_message_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      }
    }
    if (data.blobs !== void 0) {
      let data7 = data.blobs;
      if (Array.isArray(data7)) {
        const len2 = data7.length;
        for (let i2 = 0; i2 < len2; i2++) {
          let data8 = data7[i2];
          if (data8 && typeof data8 == "object" && !Array.isArray(data8)) {
            if (data8.blob_id === void 0) {
              const err19 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
            if (data8.source_id === void 0) {
              const err20 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            if (data8.status === void 0) {
              const err21 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
              if (vErrors === null) {
                vErrors = [err21];
              } else {
                vErrors.push(err21);
              }
              errors++;
            }
            if (data8.message_ids === void 0) {
              const err22 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "message_ids" }, message: "must have required property 'message_ids'" };
              if (vErrors === null) {
                vErrors = [err22];
              } else {
                vErrors.push(err22);
              }
              errors++;
            }
            if (data8.event_ids === void 0) {
              const err23 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "event_ids" }, message: "must have required property 'event_ids'" };
              if (vErrors === null) {
                vErrors = [err23];
              } else {
                vErrors.push(err23);
              }
              errors++;
            }
            if (data8.created_at === void 0) {
              const err24 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
              if (vErrors === null) {
                vErrors = [err24];
              } else {
                vErrors.push(err24);
              }
              errors++;
            }
            for (const key1 in data8) {
              if (!(key1 === "blob_id" || key1 === "source_id" || key1 === "status" || key1 === "message_ids" || key1 === "event_ids" || key1 === "created_at")) {
                const err25 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
            if (data8.blob_id !== void 0) {
              let data9 = data8.blob_id;
              if (typeof data9 === "string") {
                if (!formats0.test(data9)) {
                  const err26 = { instancePath: instancePath + "/blobs/" + i2 + "/blob_id", schemaPath: "#/components/schemas/Blob/properties/blob_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err26];
                  } else {
                    vErrors.push(err26);
                  }
                  errors++;
                }
              } else {
                const err27 = { instancePath: instancePath + "/blobs/" + i2 + "/blob_id", schemaPath: "#/components/schemas/Blob/properties/blob_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err27];
                } else {
                  vErrors.push(err27);
                }
                errors++;
              }
            }
            if (data8.source_id !== void 0) {
              if (typeof data8.source_id !== "string") {
                const err28 = { instancePath: instancePath + "/blobs/" + i2 + "/source_id", schemaPath: "#/components/schemas/Blob/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err28];
                } else {
                  vErrors.push(err28);
                }
                errors++;
              }
            }
            if (data8.status !== void 0) {
              let data11 = data8.status;
              if (typeof data11 !== "string") {
                const err29 = { instancePath: instancePath + "/blobs/" + i2 + "/status", schemaPath: "#/components/schemas/Blob/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err29];
                } else {
                  vErrors.push(err29);
                }
                errors++;
              }
              if (!(data11 === "processing" || data11 === "failed" || data11 === "active" || data11 === "retracted" || data11 === "rebuilding")) {
                const err30 = { instancePath: instancePath + "/blobs/" + i2 + "/status", schemaPath: "#/components/schemas/Blob/properties/status/enum", keyword: "enum", params: { allowedValues: schema42.properties.status.enum }, message: "must be equal to one of the allowed values" };
                if (vErrors === null) {
                  vErrors = [err30];
                } else {
                  vErrors.push(err30);
                }
                errors++;
              }
            }
            if (data8.message_ids !== void 0) {
              let data12 = data8.message_ids;
              if (Array.isArray(data12)) {
                const len3 = data12.length;
                for (let i3 = 0; i3 < len3; i3++) {
                  if (typeof data12[i3] !== "string") {
                    const err31 = { instancePath: instancePath + "/blobs/" + i2 + "/message_ids/" + i3, schemaPath: "#/components/schemas/Blob/properties/message_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err31];
                    } else {
                      vErrors.push(err31);
                    }
                    errors++;
                  }
                }
              } else {
                const err32 = { instancePath: instancePath + "/blobs/" + i2 + "/message_ids", schemaPath: "#/components/schemas/Blob/properties/message_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err32];
                } else {
                  vErrors.push(err32);
                }
                errors++;
              }
            }
            if (data8.event_ids !== void 0) {
              let data14 = data8.event_ids;
              if (Array.isArray(data14)) {
                const len4 = data14.length;
                for (let i4 = 0; i4 < len4; i4++) {
                  let data15 = data14[i4];
                  if (typeof data15 === "string") {
                    if (!formats0.test(data15)) {
                      const err33 = { instancePath: instancePath + "/blobs/" + i2 + "/event_ids/" + i4, schemaPath: "#/components/schemas/Blob/properties/event_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                      if (vErrors === null) {
                        vErrors = [err33];
                      } else {
                        vErrors.push(err33);
                      }
                      errors++;
                    }
                  } else {
                    const err34 = { instancePath: instancePath + "/blobs/" + i2 + "/event_ids/" + i4, schemaPath: "#/components/schemas/Blob/properties/event_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err34];
                    } else {
                      vErrors.push(err34);
                    }
                    errors++;
                  }
                }
              } else {
                const err35 = { instancePath: instancePath + "/blobs/" + i2 + "/event_ids", schemaPath: "#/components/schemas/Blob/properties/event_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err35];
                } else {
                  vErrors.push(err35);
                }
                errors++;
              }
            }
            if (data8.created_at !== void 0) {
              let data16 = data8.created_at;
              if (typeof data16 === "string") {
                if (!formats12.validate(data16)) {
                  const err36 = { instancePath: instancePath + "/blobs/" + i2 + "/created_at", schemaPath: "#/components/schemas/Blob/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err36];
                  } else {
                    vErrors.push(err36);
                  }
                  errors++;
                }
              } else {
                const err37 = { instancePath: instancePath + "/blobs/" + i2 + "/created_at", schemaPath: "#/components/schemas/Blob/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err37];
                } else {
                  vErrors.push(err37);
                }
                errors++;
              }
            }
          } else {
            const err38 = { instancePath: instancePath + "/blobs/" + i2, schemaPath: "#/components/schemas/Blob/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err38];
            } else {
              vErrors.push(err38);
            }
            errors++;
          }
        }
      } else {
        const err39 = { instancePath: instancePath + "/blobs", schemaPath: "#/properties/blobs/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err39];
        } else {
          vErrors.push(err39);
        }
        errors++;
      }
    }
    if (data.evidence !== void 0) {
      let data17 = data.evidence;
      if (Array.isArray(data17)) {
        const len5 = data17.length;
        for (let i5 = 0; i5 < len5; i5++) {
          if (!validate35(data17[i5], { instancePath: instancePath + "/evidence/" + i5, parentData: data17, parentDataProperty: i5, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate35.errors : vErrors.concat(validate35.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err40 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err40];
        } else {
          vErrors.push(err40);
        }
        errors++;
      }
    }
    if (data.next_message_offset !== void 0) {
      let data19 = data.next_message_offset;
      const _errs42 = errors;
      let valid15 = false;
      const _errs43 = errors;
      if (!(typeof data19 == "number" && (!(data19 % 1) && !isNaN(data19)))) {
        const err41 = { instancePath: instancePath + "/next_message_offset", schemaPath: "#/properties/next_message_offset/anyOf/0/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err41];
        } else {
          vErrors.push(err41);
        }
        errors++;
      }
      var _valid0 = _errs43 === errors;
      valid15 = valid15 || _valid0;
      const _errs45 = errors;
      if (data19 !== null) {
        const err42 = { instancePath: instancePath + "/next_message_offset", schemaPath: "#/properties/next_message_offset/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err42];
        } else {
          vErrors.push(err42);
        }
        errors++;
      }
      var _valid0 = _errs45 === errors;
      valid15 = valid15 || _valid0;
      if (!valid15) {
        const err43 = { instancePath: instancePath + "/next_message_offset", schemaPath: "#/properties/next_message_offset/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err43];
        } else {
          vErrors.push(err43);
        }
        errors++;
      } else {
        errors = _errs42;
        if (vErrors !== null) {
          if (_errs42) {
            vErrors.length = _errs42;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.next_blob_offset !== void 0) {
      let data20 = data.next_blob_offset;
      const _errs48 = errors;
      let valid16 = false;
      const _errs49 = errors;
      if (!(typeof data20 == "number" && (!(data20 % 1) && !isNaN(data20)))) {
        const err44 = { instancePath: instancePath + "/next_blob_offset", schemaPath: "#/properties/next_blob_offset/anyOf/0/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err44];
        } else {
          vErrors.push(err44);
        }
        errors++;
      }
      var _valid1 = _errs49 === errors;
      valid16 = valid16 || _valid1;
      const _errs51 = errors;
      if (data20 !== null) {
        const err45 = { instancePath: instancePath + "/next_blob_offset", schemaPath: "#/properties/next_blob_offset/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err45];
        } else {
          vErrors.push(err45);
        }
        errors++;
      }
      var _valid1 = _errs51 === errors;
      valid16 = valid16 || _valid1;
      if (!valid16) {
        const err46 = { instancePath: instancePath + "/next_blob_offset", schemaPath: "#/properties/next_blob_offset/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err46];
        } else {
          vErrors.push(err46);
        }
        errors++;
      } else {
        errors = _errs48;
        if (vErrors !== null) {
          if (_errs48) {
            vErrors.length = _errs48;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.next_evidence_offset !== void 0) {
      let data21 = data.next_evidence_offset;
      const _errs54 = errors;
      let valid17 = false;
      const _errs55 = errors;
      if (!(typeof data21 == "number" && (!(data21 % 1) && !isNaN(data21)))) {
        const err47 = { instancePath: instancePath + "/next_evidence_offset", schemaPath: "#/properties/next_evidence_offset/anyOf/0/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err47];
        } else {
          vErrors.push(err47);
        }
        errors++;
      }
      var _valid2 = _errs55 === errors;
      valid17 = valid17 || _valid2;
      const _errs57 = errors;
      if (data21 !== null) {
        const err48 = { instancePath: instancePath + "/next_evidence_offset", schemaPath: "#/properties/next_evidence_offset/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err48];
        } else {
          vErrors.push(err48);
        }
        errors++;
      }
      var _valid2 = _errs57 === errors;
      valid17 = valid17 || _valid2;
      if (!valid17) {
        const err49 = { instancePath: instancePath + "/next_evidence_offset", schemaPath: "#/properties/next_evidence_offset/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err49];
        } else {
          vErrors.push(err49);
        }
        errors++;
      } else {
        errors = _errs54;
        if (vErrors !== null) {
          if (_errs54) {
            vErrors.length = _errs54;
          } else {
            vErrors = null;
          }
        }
      }
    }
  } else {
    const err50 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err50];
    } else {
      vErrors.push(err50);
    }
    errors++;
  }
  validate34.errors = vErrors;
  return errors === 0;
}
validate34.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate33(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate33.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate34(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate34.errors : vErrors.concat(validate34.errors);
    errors = vErrors.length;
  }
  validate33.errors = vErrors;
  return errors === 0;
}
validate33.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateSourceQuery = validate40;
function validate40(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate40.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "message_offset" || key0 === "blob_offset" || key0 === "evidence_offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.message_offset !== void 0) {
      let data1 = data.message_offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/message_offset", schemaPath: "#/allOf/0/properties/message_offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/message_offset", schemaPath: "#/allOf/0/properties/message_offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
    if (data.blob_offset !== void 0) {
      let data2 = data.blob_offset;
      if (!(typeof data2 == "number" && (!(data2 % 1) && !isNaN(data2)))) {
        const err6 = { instancePath: instancePath + "/blob_offset", schemaPath: "#/allOf/0/properties/blob_offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
      if (typeof data2 == "number") {
        if (data2 < 0 || isNaN(data2)) {
          const err7 = { instancePath: instancePath + "/blob_offset", schemaPath: "#/allOf/0/properties/blob_offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      }
    }
    if (data.evidence_offset !== void 0) {
      let data3 = data.evidence_offset;
      if (!(typeof data3 == "number" && (!(data3 % 1) && !isNaN(data3)))) {
        const err8 = { instancePath: instancePath + "/evidence_offset", schemaPath: "#/allOf/0/properties/evidence_offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
      if (typeof data3 == "number") {
        if (data3 < 0 || isNaN(data3)) {
          const err9 = { instancePath: instancePath + "/evidence_offset", schemaPath: "#/allOf/0/properties/evidence_offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      }
    }
  } else {
    const err10 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err10];
    } else {
      vErrors.push(err10);
    }
    errors++;
  }
  validate40.errors = vErrors;
  return errors === 0;
}
validate40.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProfiles = validate41;
function validate42(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate42.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.profiles === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "profiles" }, message: "must have required property 'profiles'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "profiles")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.profiles !== void 0) {
      let data0 = data.profiles;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.id === void 0) {
              const err2 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
            if (data1.content === void 0) {
              const err3 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
              if (vErrors === null) {
                vErrors = [err3];
              } else {
                vErrors.push(err3);
              }
              errors++;
            }
            if (data1.topic === void 0) {
              const err4 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            if (data1.sub_topic === void 0) {
              const err5 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
              if (vErrors === null) {
                vErrors = [err5];
              } else {
                vErrors.push(err5);
              }
              errors++;
            }
            if (data1.source_ids === void 0) {
              const err6 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "source_ids" }, message: "must have required property 'source_ids'" };
              if (vErrors === null) {
                vErrors = [err6];
              } else {
                vErrors.push(err6);
              }
              errors++;
            }
            if (data1.updated_at === void 0) {
              const err7 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/required", keyword: "required", params: { missingProperty: "updated_at" }, message: "must have required property 'updated_at'" };
              if (vErrors === null) {
                vErrors = [err7];
              } else {
                vErrors.push(err7);
              }
              errors++;
            }
            for (const key1 in data1) {
              if (!(key1 === "id" || key1 === "content" || key1 === "topic" || key1 === "sub_topic" || key1 === "source_ids" || key1 === "updated_at")) {
                const err8 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err8];
                } else {
                  vErrors.push(err8);
                }
                errors++;
              }
            }
            if (data1.id !== void 0) {
              let data2 = data1.id;
              if (typeof data2 === "string") {
                if (!formats0.test(data2)) {
                  const err9 = { instancePath: instancePath + "/profiles/" + i0 + "/id", schemaPath: "#/components/schemas/Profile/properties/id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err9];
                  } else {
                    vErrors.push(err9);
                  }
                  errors++;
                }
              } else {
                const err10 = { instancePath: instancePath + "/profiles/" + i0 + "/id", schemaPath: "#/components/schemas/Profile/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err10];
                } else {
                  vErrors.push(err10);
                }
                errors++;
              }
            }
            if (data1.content !== void 0) {
              if (typeof data1.content !== "string") {
                const err11 = { instancePath: instancePath + "/profiles/" + i0 + "/content", schemaPath: "#/components/schemas/Profile/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err11];
                } else {
                  vErrors.push(err11);
                }
                errors++;
              }
            }
            if (data1.topic !== void 0) {
              if (typeof data1.topic !== "string") {
                const err12 = { instancePath: instancePath + "/profiles/" + i0 + "/topic", schemaPath: "#/components/schemas/Profile/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err12];
                } else {
                  vErrors.push(err12);
                }
                errors++;
              }
            }
            if (data1.sub_topic !== void 0) {
              if (typeof data1.sub_topic !== "string") {
                const err13 = { instancePath: instancePath + "/profiles/" + i0 + "/sub_topic", schemaPath: "#/components/schemas/Profile/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err13];
                } else {
                  vErrors.push(err13);
                }
                errors++;
              }
            }
            if (data1.source_ids !== void 0) {
              let data6 = data1.source_ids;
              if (Array.isArray(data6)) {
                const len1 = data6.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  if (typeof data6[i1] !== "string") {
                    const err14 = { instancePath: instancePath + "/profiles/" + i0 + "/source_ids/" + i1, schemaPath: "#/components/schemas/Profile/properties/source_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err14];
                    } else {
                      vErrors.push(err14);
                    }
                    errors++;
                  }
                }
              } else {
                const err15 = { instancePath: instancePath + "/profiles/" + i0 + "/source_ids", schemaPath: "#/components/schemas/Profile/properties/source_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err15];
                } else {
                  vErrors.push(err15);
                }
                errors++;
              }
            }
            if (data1.updated_at !== void 0) {
              let data8 = data1.updated_at;
              if (typeof data8 === "string") {
                if (!formats12.validate(data8)) {
                  const err16 = { instancePath: instancePath + "/profiles/" + i0 + "/updated_at", schemaPath: "#/components/schemas/Profile/properties/updated_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err16];
                  } else {
                    vErrors.push(err16);
                  }
                  errors++;
                }
              } else {
                const err17 = { instancePath: instancePath + "/profiles/" + i0 + "/updated_at", schemaPath: "#/components/schemas/Profile/properties/updated_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err17];
                } else {
                  vErrors.push(err17);
                }
                errors++;
              }
            }
          } else {
            const err18 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/Profile/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
      } else {
        const err19 = { instancePath: instancePath + "/profiles", schemaPath: "#/properties/profiles/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
  } else {
    const err20 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err20];
    } else {
      vErrors.push(err20);
    }
    errors++;
  }
  validate42.errors = vErrors;
  return errors === 0;
}
validate42.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate41(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate41.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate42(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate42.errors : vErrors.concat(validate42.errors);
    errors = vErrors.length;
  }
  validate41.errors = vErrors;
  return errors === 0;
}
validate41.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateSearch = validate44;
function validate48(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate48.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.start === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "start" }, message: "must have required property 'start'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.end === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "end" }, message: "must have required property 'end'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.precision === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "precision" }, message: "must have required property 'precision'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.evidence === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "evidence" }, message: "must have required property 'evidence'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "start" || key0 === "end" || key0 === "precision" || key0 === "evidence")) {
        const err4 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.start !== void 0) {
      let data0 = data.start;
      const _errs3 = errors;
      let valid1 = false;
      const _errs4 = errors;
      if (typeof data0 === "string") {
        if (!formats34.validate(data0)) {
          const err5 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/0/format", keyword: "format", params: { format: "date" }, message: 'must match format "date"' };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      } else {
        const err6 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
      var _valid0 = _errs4 === errors;
      valid1 = valid1 || _valid0;
      const _errs6 = errors;
      if (data0 !== null) {
        const err7 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
      var _valid0 = _errs6 === errors;
      valid1 = valid1 || _valid0;
      if (!valid1) {
        const err8 = { instancePath: instancePath + "/start", schemaPath: "#/properties/start/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      } else {
        errors = _errs3;
        if (vErrors !== null) {
          if (_errs3) {
            vErrors.length = _errs3;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.end !== void 0) {
      let data1 = data.end;
      const _errs9 = errors;
      let valid2 = false;
      const _errs10 = errors;
      if (typeof data1 === "string") {
        if (!formats34.validate(data1)) {
          const err9 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/0/format", keyword: "format", params: { format: "date" }, message: 'must match format "date"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      var _valid1 = _errs10 === errors;
      valid2 = valid2 || _valid1;
      const _errs12 = errors;
      if (data1 !== null) {
        const err11 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      var _valid1 = _errs12 === errors;
      valid2 = valid2 || _valid1;
      if (!valid2) {
        const err12 = { instancePath: instancePath + "/end", schemaPath: "#/properties/end/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      } else {
        errors = _errs9;
        if (vErrors !== null) {
          if (_errs9) {
            vErrors.length = _errs9;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.precision !== void 0) {
      let data2 = data.precision;
      if (typeof data2 !== "string") {
        const err13 = { instancePath: instancePath + "/precision", schemaPath: "#/properties/precision/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      if (!(data2 === "year" || data2 === "month" || data2 === "day" || data2 === "range" || data2 === "unknown")) {
        const err14 = { instancePath: instancePath + "/precision", schemaPath: "#/properties/precision/enum", keyword: "enum", params: { allowedValues: schema52.properties.precision.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.evidence !== void 0) {
      let data3 = data.evidence;
      if (Array.isArray(data3)) {
        if (data3.length > 20) {
          const err15 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/maxItems", keyword: "maxItems", params: { limit: 20 }, message: "must NOT have more than 20 items" };
          if (vErrors === null) {
            vErrors = [err15];
          } else {
            vErrors.push(err15);
          }
          errors++;
        }
        if (data3.length < 1) {
          const err16 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        const len0 = data3.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data4 = data3[i0];
          if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
            if (data4.message_id === void 0) {
              const err17 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/required", keyword: "required", params: { missingProperty: "message_id" }, message: "must have required property 'message_id'" };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
            if (data4.expression === void 0) {
              const err18 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/required", keyword: "required", params: { missingProperty: "expression" }, message: "must have required property 'expression'" };
              if (vErrors === null) {
                vErrors = [err18];
              } else {
                vErrors.push(err18);
              }
              errors++;
            }
            for (const key1 in data4) {
              if (!(key1 === "message_id" || key1 === "expression")) {
                const err19 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err19];
                } else {
                  vErrors.push(err19);
                }
                errors++;
              }
            }
            if (data4.message_id !== void 0) {
              let data5 = data4.message_id;
              if (typeof data5 === "string") {
                if (func1(data5) > 255) {
                  const err20 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/maxLength", keyword: "maxLength", params: { limit: 255 }, message: "must NOT have more than 255 characters" };
                  if (vErrors === null) {
                    vErrors = [err20];
                  } else {
                    vErrors.push(err20);
                  }
                  errors++;
                }
                if (func1(data5) < 1) {
                  const err21 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err21];
                  } else {
                    vErrors.push(err21);
                  }
                  errors++;
                }
              } else {
                const err22 = { instancePath: instancePath + "/evidence/" + i0 + "/message_id", schemaPath: "#/components/schemas/TimeEvidence/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
            }
            if (data4.expression !== void 0) {
              let data6 = data4.expression;
              if (typeof data6 === "string") {
                if (func1(data6) > 1024) {
                  const err23 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/maxLength", keyword: "maxLength", params: { limit: 1024 }, message: "must NOT have more than 1024 characters" };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
                if (func1(data6) < 1) {
                  const err24 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
                  if (vErrors === null) {
                    vErrors = [err24];
                  } else {
                    vErrors.push(err24);
                  }
                  errors++;
                }
              } else {
                const err25 = { instancePath: instancePath + "/evidence/" + i0 + "/expression", schemaPath: "#/components/schemas/TimeEvidence/properties/expression/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
          } else {
            const err26 = { instancePath: instancePath + "/evidence/" + i0, schemaPath: "#/components/schemas/TimeEvidence/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err26];
            } else {
              vErrors.push(err26);
            }
            errors++;
          }
        }
      } else {
        const err27 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      }
    }
  } else {
    const err28 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err28];
    } else {
      vErrors.push(err28);
    }
    errors++;
  }
  validate48.errors = vErrors;
  return errors === 0;
}
validate48.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate47(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate47.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.fact_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "fact_id" }, message: "must have required property 'fact_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.blob_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.content === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.topic === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.sub_topic === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.support_groups === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "support_groups" }, message: "must have required property 'support_groups'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "fact_id" || key0 === "blob_id" || key0 === "content" || key0 === "topic" || key0 === "sub_topic" || key0 === "support_groups" || key0 === "event_time" || key0 === "source_messages")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.fact_id !== void 0) {
      let data0 = data.fact_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/fact_id", schemaPath: "#/properties/fact_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/fact_id", schemaPath: "#/properties/fact_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.blob_id !== void 0) {
      let data1 = data.blob_id;
      if (typeof data1 === "string") {
        if (!formats0.test(data1)) {
          const err9 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err9];
          } else {
            vErrors.push(err9);
          }
          errors++;
        }
      } else {
        const err10 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.content !== void 0) {
      if (typeof data.content !== "string") {
        const err11 = { instancePath: instancePath + "/content", schemaPath: "#/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.topic !== void 0) {
      if (typeof data.topic !== "string") {
        const err12 = { instancePath: instancePath + "/topic", schemaPath: "#/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.sub_topic !== void 0) {
      if (typeof data.sub_topic !== "string") {
        const err13 = { instancePath: instancePath + "/sub_topic", schemaPath: "#/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.support_groups !== void 0) {
      let data5 = data.support_groups;
      if (Array.isArray(data5)) {
        const len0 = data5.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data6 = data5[i0];
          if (Array.isArray(data6)) {
            const len1 = data6.length;
            for (let i1 = 0; i1 < len1; i1++) {
              if (typeof data6[i1] !== "string") {
                const err14 = { instancePath: instancePath + "/support_groups/" + i0 + "/" + i1, schemaPath: "#/properties/support_groups/items/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err14];
                } else {
                  vErrors.push(err14);
                }
                errors++;
              }
            }
          } else {
            const err15 = { instancePath: instancePath + "/support_groups/" + i0, schemaPath: "#/properties/support_groups/items/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err15];
            } else {
              vErrors.push(err15);
            }
            errors++;
          }
        }
      } else {
        const err16 = { instancePath: instancePath + "/support_groups", schemaPath: "#/properties/support_groups/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
    }
    if (data.event_time !== void 0) {
      let data8 = data.event_time;
      const _errs19 = errors;
      let valid5 = false;
      const _errs20 = errors;
      if (!validate48(data8, { instancePath: instancePath + "/event_time", parentData: data, parentDataProperty: "event_time", rootData, dynamicAnchors })) {
        vErrors = vErrors === null ? validate48.errors : vErrors.concat(validate48.errors);
        errors = vErrors.length;
      }
      var _valid0 = _errs20 === errors;
      valid5 = valid5 || _valid0;
      const _errs21 = errors;
      if (data8 !== null) {
        const err17 = { instancePath: instancePath + "/event_time", schemaPath: "#/properties/event_time/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
      var _valid0 = _errs21 === errors;
      valid5 = valid5 || _valid0;
      if (!valid5) {
        const err18 = { instancePath: instancePath + "/event_time", schemaPath: "#/properties/event_time/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err18];
        } else {
          vErrors.push(err18);
        }
        errors++;
      } else {
        errors = _errs19;
        if (vErrors !== null) {
          if (_errs19) {
            vErrors.length = _errs19;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.source_messages !== void 0) {
      let data9 = data.source_messages;
      if (Array.isArray(data9)) {
        const len2 = data9.length;
        for (let i2 = 0; i2 < len2; i2++) {
          let data10 = data9[i2];
          if (data10 && typeof data10 == "object" && !Array.isArray(data10)) {
            if (data10.message_id === void 0) {
              const err19 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/required", keyword: "required", params: { missingProperty: "message_id" }, message: "must have required property 'message_id'" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
            if (data10.recorded_at === void 0) {
              const err20 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/required", keyword: "required", params: { missingProperty: "recorded_at" }, message: "must have required property 'recorded_at'" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            for (const key1 in data10) {
              if (!(key1 === "message_id" || key1 === "recorded_at" || key1 === "time_zone")) {
                const err21 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
            }
            if (data10.message_id !== void 0) {
              if (typeof data10.message_id !== "string") {
                const err22 = { instancePath: instancePath + "/source_messages/" + i2 + "/message_id", schemaPath: "#/components/schemas/SourceObservation/properties/message_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              }
            }
            if (data10.recorded_at !== void 0) {
              let data12 = data10.recorded_at;
              if (typeof data12 === "string") {
                if (!formats12.validate(data12)) {
                  const err23 = { instancePath: instancePath + "/source_messages/" + i2 + "/recorded_at", schemaPath: "#/components/schemas/SourceObservation/properties/recorded_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
              } else {
                const err24 = { instancePath: instancePath + "/source_messages/" + i2 + "/recorded_at", schemaPath: "#/components/schemas/SourceObservation/properties/recorded_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
            }
            if (data10.time_zone !== void 0) {
              let data13 = data10.time_zone;
              const _errs34 = errors;
              let valid10 = false;
              const _errs35 = errors;
              if (typeof data13 !== "string") {
                const err25 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
              var _valid1 = _errs35 === errors;
              valid10 = valid10 || _valid1;
              const _errs37 = errors;
              if (data13 !== null) {
                const err26 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
              var _valid1 = _errs37 === errors;
              valid10 = valid10 || _valid1;
              if (!valid10) {
                const err27 = { instancePath: instancePath + "/source_messages/" + i2 + "/time_zone", schemaPath: "#/components/schemas/SourceObservation/properties/time_zone/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err27];
                } else {
                  vErrors.push(err27);
                }
                errors++;
              } else {
                errors = _errs34;
                if (vErrors !== null) {
                  if (_errs34) {
                    vErrors.length = _errs34;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
          } else {
            const err28 = { instancePath: instancePath + "/source_messages/" + i2, schemaPath: "#/components/schemas/SourceObservation/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err28];
            } else {
              vErrors.push(err28);
            }
            errors++;
          }
        }
      } else {
        const err29 = { instancePath: instancePath + "/source_messages", schemaPath: "#/properties/source_messages/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err29];
        } else {
          vErrors.push(err29);
        }
        errors++;
      }
    }
  } else {
    const err30 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err30];
    } else {
      vErrors.push(err30);
    }
    errors++;
  }
  validate47.errors = vErrors;
  return errors === 0;
}
validate47.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate46(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate46.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.content === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.blob_id === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.score === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "score" }, message: "must have required property 'score'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.occurred_at === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "occurred_at" }, message: "must have required property 'occurred_at'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "id" || key0 === "content" || key0 === "source_id" || key0 === "blob_id" || key0 === "score" || key0 === "occurred_at" || key0 === "evidence")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.id !== void 0) {
      let data0 = data.id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/id", schemaPath: "#/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.content !== void 0) {
      if (typeof data.content !== "string") {
        const err9 = { instancePath: instancePath + "/content", schemaPath: "#/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      let data2 = data.source_id;
      const _errs7 = errors;
      let valid1 = false;
      const _errs8 = errors;
      if (typeof data2 !== "string") {
        const err10 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
      var _valid0 = _errs8 === errors;
      valid1 = valid1 || _valid0;
      const _errs10 = errors;
      if (data2 !== null) {
        const err11 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
      var _valid0 = _errs10 === errors;
      valid1 = valid1 || _valid0;
      if (!valid1) {
        const err12 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      } else {
        errors = _errs7;
        if (vErrors !== null) {
          if (_errs7) {
            vErrors.length = _errs7;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.blob_id !== void 0) {
      let data3 = data.blob_id;
      const _errs13 = errors;
      let valid2 = false;
      const _errs14 = errors;
      if (typeof data3 === "string") {
        if (!formats0.test(data3)) {
          const err13 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      } else {
        const err14 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
      var _valid1 = _errs14 === errors;
      valid2 = valid2 || _valid1;
      const _errs16 = errors;
      if (data3 !== null) {
        const err15 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
      var _valid1 = _errs16 === errors;
      valid2 = valid2 || _valid1;
      if (!valid2) {
        const err16 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      } else {
        errors = _errs13;
        if (vErrors !== null) {
          if (_errs13) {
            vErrors.length = _errs13;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.score !== void 0) {
      if (!(typeof data.score == "number")) {
        const err17 = { instancePath: instancePath + "/score", schemaPath: "#/properties/score/type", keyword: "type", params: { type: "number" }, message: "must be number" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      }
    }
    if (data.occurred_at !== void 0) {
      let data5 = data.occurred_at;
      if (typeof data5 === "string") {
        if (!formats12.validate(data5)) {
          const err18 = { instancePath: instancePath + "/occurred_at", schemaPath: "#/properties/occurred_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      } else {
        const err19 = { instancePath: instancePath + "/occurred_at", schemaPath: "#/properties/occurred_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
    }
    if (data.evidence !== void 0) {
      let data6 = data.evidence;
      if (Array.isArray(data6)) {
        const len0 = data6.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate47(data6[i0], { instancePath: instancePath + "/evidence/" + i0, parentData: data6, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate47.errors : vErrors.concat(validate47.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err20 = { instancePath: instancePath + "/evidence", schemaPath: "#/properties/evidence/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
    }
  } else {
    const err21 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err21];
    } else {
      vErrors.push(err21);
    }
    errors++;
  }
  validate46.errors = vErrors;
  return errors === 0;
}
validate46.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate45(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate45.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.events === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "events" }, message: "must have required property 'events'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "events")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.events !== void 0) {
      let data0 = data.events;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate46(data0[i0], { instancePath: instancePath + "/events/" + i0, parentData: data0, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate46.errors : vErrors.concat(validate46.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err2 = { instancePath: instancePath + "/events", schemaPath: "#/properties/events/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate45.errors = vErrors;
  return errors === 0;
}
validate45.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate44(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate44.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate45(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate45.errors : vErrors.concat(validate45.errors);
    errors = vErrors.length;
  }
  validate44.errors = vErrors;
  return errors === 0;
}
validate44.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateHistory = validate53;
function validate55(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate55.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.revision_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "revision_id" }, message: "must have required property 'revision_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.operation_id === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "operation_id" }, message: "must have required property 'operation_id'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.profiles === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "profiles" }, message: "must have required property 'profiles'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.added === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "added" }, message: "must have required property 'added'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.removed === void 0) {
      const err6 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "removed" }, message: "must have required property 'removed'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "revision_id" || key0 === "operation_id" || key0 === "source_id" || key0 === "created_at" || key0 === "profiles" || key0 === "added" || key0 === "removed")) {
        const err7 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.revision_id !== void 0) {
      let data0 = data.revision_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err8 = { instancePath: instancePath + "/revision_id", schemaPath: "#/properties/revision_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      } else {
        const err9 = { instancePath: instancePath + "/revision_id", schemaPath: "#/properties/revision_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.operation_id !== void 0) {
      let data1 = data.operation_id;
      if (typeof data1 === "string") {
        if (!formats0.test(data1)) {
          const err10 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err10];
          } else {
            vErrors.push(err10);
          }
          errors++;
        }
      } else {
        const err11 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      if (typeof data.source_id !== "string") {
        const err12 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
    }
    if (data.created_at !== void 0) {
      let data3 = data.created_at;
      if (typeof data3 === "string") {
        if (!formats12.validate(data3)) {
          const err13 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err13];
          } else {
            vErrors.push(err13);
          }
          errors++;
        }
      } else {
        const err14 = { instancePath: instancePath + "/created_at", schemaPath: "#/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
    }
    if (data.profiles !== void 0) {
      let data4 = data.profiles;
      if (Array.isArray(data4)) {
        const len0 = data4.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data5 = data4[i0];
          if (data5 && typeof data5 == "object" && !Array.isArray(data5)) {
            if (data5.id === void 0) {
              const err15 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err15];
              } else {
                vErrors.push(err15);
              }
              errors++;
            }
            if (data5.content === void 0) {
              const err16 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
              if (vErrors === null) {
                vErrors = [err16];
              } else {
                vErrors.push(err16);
              }
              errors++;
            }
            if (data5.topic === void 0) {
              const err17 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
              if (vErrors === null) {
                vErrors = [err17];
              } else {
                vErrors.push(err17);
              }
              errors++;
            }
            if (data5.sub_topic === void 0) {
              const err18 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
              if (vErrors === null) {
                vErrors = [err18];
              } else {
                vErrors.push(err18);
              }
              errors++;
            }
            if (data5.source_ids === void 0) {
              const err19 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "source_ids" }, message: "must have required property 'source_ids'" };
              if (vErrors === null) {
                vErrors = [err19];
              } else {
                vErrors.push(err19);
              }
              errors++;
            }
            if (data5.fact_ids === void 0) {
              const err20 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "fact_ids" }, message: "must have required property 'fact_ids'" };
              if (vErrors === null) {
                vErrors = [err20];
              } else {
                vErrors.push(err20);
              }
              errors++;
            }
            for (const key1 in data5) {
              if (!(key1 === "id" || key1 === "content" || key1 === "topic" || key1 === "sub_topic" || key1 === "source_ids" || key1 === "fact_ids")) {
                const err21 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
            }
            if (data5.id !== void 0) {
              let data6 = data5.id;
              if (typeof data6 === "string") {
                if (!formats0.test(data6)) {
                  const err22 = { instancePath: instancePath + "/profiles/" + i0 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err22];
                  } else {
                    vErrors.push(err22);
                  }
                  errors++;
                }
              } else {
                const err23 = { instancePath: instancePath + "/profiles/" + i0 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err23];
                } else {
                  vErrors.push(err23);
                }
                errors++;
              }
            }
            if (data5.content !== void 0) {
              if (typeof data5.content !== "string") {
                const err24 = { instancePath: instancePath + "/profiles/" + i0 + "/content", schemaPath: "#/components/schemas/HistoricalProfile/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
            }
            if (data5.topic !== void 0) {
              if (typeof data5.topic !== "string") {
                const err25 = { instancePath: instancePath + "/profiles/" + i0 + "/topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err25];
                } else {
                  vErrors.push(err25);
                }
                errors++;
              }
            }
            if (data5.sub_topic !== void 0) {
              if (typeof data5.sub_topic !== "string") {
                const err26 = { instancePath: instancePath + "/profiles/" + i0 + "/sub_topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err26];
                } else {
                  vErrors.push(err26);
                }
                errors++;
              }
            }
            if (data5.source_ids !== void 0) {
              let data10 = data5.source_ids;
              if (Array.isArray(data10)) {
                const len1 = data10.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  if (typeof data10[i1] !== "string") {
                    const err27 = { instancePath: instancePath + "/profiles/" + i0 + "/source_ids/" + i1, schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err27];
                    } else {
                      vErrors.push(err27);
                    }
                    errors++;
                  }
                }
              } else {
                const err28 = { instancePath: instancePath + "/profiles/" + i0 + "/source_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err28];
                } else {
                  vErrors.push(err28);
                }
                errors++;
              }
            }
            if (data5.fact_ids !== void 0) {
              let data12 = data5.fact_ids;
              if (Array.isArray(data12)) {
                const len2 = data12.length;
                for (let i2 = 0; i2 < len2; i2++) {
                  let data13 = data12[i2];
                  if (typeof data13 === "string") {
                    if (!formats0.test(data13)) {
                      const err29 = { instancePath: instancePath + "/profiles/" + i0 + "/fact_ids/" + i2, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                      if (vErrors === null) {
                        vErrors = [err29];
                      } else {
                        vErrors.push(err29);
                      }
                      errors++;
                    }
                  } else {
                    const err30 = { instancePath: instancePath + "/profiles/" + i0 + "/fact_ids/" + i2, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err30];
                    } else {
                      vErrors.push(err30);
                    }
                    errors++;
                  }
                }
              } else {
                const err31 = { instancePath: instancePath + "/profiles/" + i0 + "/fact_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err31];
                } else {
                  vErrors.push(err31);
                }
                errors++;
              }
            }
          } else {
            const err32 = { instancePath: instancePath + "/profiles/" + i0, schemaPath: "#/components/schemas/HistoricalProfile/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err32];
            } else {
              vErrors.push(err32);
            }
            errors++;
          }
        }
      } else {
        const err33 = { instancePath: instancePath + "/profiles", schemaPath: "#/properties/profiles/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
    }
    if (data.added !== void 0) {
      let data14 = data.added;
      if (Array.isArray(data14)) {
        const len3 = data14.length;
        for (let i3 = 0; i3 < len3; i3++) {
          let data15 = data14[i3];
          if (data15 && typeof data15 == "object" && !Array.isArray(data15)) {
            if (data15.id === void 0) {
              const err34 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err34];
              } else {
                vErrors.push(err34);
              }
              errors++;
            }
            if (data15.content === void 0) {
              const err35 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
              if (vErrors === null) {
                vErrors = [err35];
              } else {
                vErrors.push(err35);
              }
              errors++;
            }
            if (data15.topic === void 0) {
              const err36 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
              if (vErrors === null) {
                vErrors = [err36];
              } else {
                vErrors.push(err36);
              }
              errors++;
            }
            if (data15.sub_topic === void 0) {
              const err37 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
              if (vErrors === null) {
                vErrors = [err37];
              } else {
                vErrors.push(err37);
              }
              errors++;
            }
            if (data15.source_ids === void 0) {
              const err38 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "source_ids" }, message: "must have required property 'source_ids'" };
              if (vErrors === null) {
                vErrors = [err38];
              } else {
                vErrors.push(err38);
              }
              errors++;
            }
            if (data15.fact_ids === void 0) {
              const err39 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "fact_ids" }, message: "must have required property 'fact_ids'" };
              if (vErrors === null) {
                vErrors = [err39];
              } else {
                vErrors.push(err39);
              }
              errors++;
            }
            for (const key2 in data15) {
              if (!(key2 === "id" || key2 === "content" || key2 === "topic" || key2 === "sub_topic" || key2 === "source_ids" || key2 === "fact_ids")) {
                const err40 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key2 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err40];
                } else {
                  vErrors.push(err40);
                }
                errors++;
              }
            }
            if (data15.id !== void 0) {
              let data16 = data15.id;
              if (typeof data16 === "string") {
                if (!formats0.test(data16)) {
                  const err41 = { instancePath: instancePath + "/added/" + i3 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err41];
                  } else {
                    vErrors.push(err41);
                  }
                  errors++;
                }
              } else {
                const err42 = { instancePath: instancePath + "/added/" + i3 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err42];
                } else {
                  vErrors.push(err42);
                }
                errors++;
              }
            }
            if (data15.content !== void 0) {
              if (typeof data15.content !== "string") {
                const err43 = { instancePath: instancePath + "/added/" + i3 + "/content", schemaPath: "#/components/schemas/HistoricalProfile/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err43];
                } else {
                  vErrors.push(err43);
                }
                errors++;
              }
            }
            if (data15.topic !== void 0) {
              if (typeof data15.topic !== "string") {
                const err44 = { instancePath: instancePath + "/added/" + i3 + "/topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err44];
                } else {
                  vErrors.push(err44);
                }
                errors++;
              }
            }
            if (data15.sub_topic !== void 0) {
              if (typeof data15.sub_topic !== "string") {
                const err45 = { instancePath: instancePath + "/added/" + i3 + "/sub_topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err45];
                } else {
                  vErrors.push(err45);
                }
                errors++;
              }
            }
            if (data15.source_ids !== void 0) {
              let data20 = data15.source_ids;
              if (Array.isArray(data20)) {
                const len4 = data20.length;
                for (let i4 = 0; i4 < len4; i4++) {
                  if (typeof data20[i4] !== "string") {
                    const err46 = { instancePath: instancePath + "/added/" + i3 + "/source_ids/" + i4, schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err46];
                    } else {
                      vErrors.push(err46);
                    }
                    errors++;
                  }
                }
              } else {
                const err47 = { instancePath: instancePath + "/added/" + i3 + "/source_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err47];
                } else {
                  vErrors.push(err47);
                }
                errors++;
              }
            }
            if (data15.fact_ids !== void 0) {
              let data22 = data15.fact_ids;
              if (Array.isArray(data22)) {
                const len5 = data22.length;
                for (let i5 = 0; i5 < len5; i5++) {
                  let data23 = data22[i5];
                  if (typeof data23 === "string") {
                    if (!formats0.test(data23)) {
                      const err48 = { instancePath: instancePath + "/added/" + i3 + "/fact_ids/" + i5, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                      if (vErrors === null) {
                        vErrors = [err48];
                      } else {
                        vErrors.push(err48);
                      }
                      errors++;
                    }
                  } else {
                    const err49 = { instancePath: instancePath + "/added/" + i3 + "/fact_ids/" + i5, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err49];
                    } else {
                      vErrors.push(err49);
                    }
                    errors++;
                  }
                }
              } else {
                const err50 = { instancePath: instancePath + "/added/" + i3 + "/fact_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err50];
                } else {
                  vErrors.push(err50);
                }
                errors++;
              }
            }
          } else {
            const err51 = { instancePath: instancePath + "/added/" + i3, schemaPath: "#/components/schemas/HistoricalProfile/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err51];
            } else {
              vErrors.push(err51);
            }
            errors++;
          }
        }
      } else {
        const err52 = { instancePath: instancePath + "/added", schemaPath: "#/properties/added/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err52];
        } else {
          vErrors.push(err52);
        }
        errors++;
      }
    }
    if (data.removed !== void 0) {
      let data24 = data.removed;
      if (Array.isArray(data24)) {
        const len6 = data24.length;
        for (let i6 = 0; i6 < len6; i6++) {
          let data25 = data24[i6];
          if (data25 && typeof data25 == "object" && !Array.isArray(data25)) {
            if (data25.id === void 0) {
              const err53 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "id" }, message: "must have required property 'id'" };
              if (vErrors === null) {
                vErrors = [err53];
              } else {
                vErrors.push(err53);
              }
              errors++;
            }
            if (data25.content === void 0) {
              const err54 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "content" }, message: "must have required property 'content'" };
              if (vErrors === null) {
                vErrors = [err54];
              } else {
                vErrors.push(err54);
              }
              errors++;
            }
            if (data25.topic === void 0) {
              const err55 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "topic" }, message: "must have required property 'topic'" };
              if (vErrors === null) {
                vErrors = [err55];
              } else {
                vErrors.push(err55);
              }
              errors++;
            }
            if (data25.sub_topic === void 0) {
              const err56 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "sub_topic" }, message: "must have required property 'sub_topic'" };
              if (vErrors === null) {
                vErrors = [err56];
              } else {
                vErrors.push(err56);
              }
              errors++;
            }
            if (data25.source_ids === void 0) {
              const err57 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "source_ids" }, message: "must have required property 'source_ids'" };
              if (vErrors === null) {
                vErrors = [err57];
              } else {
                vErrors.push(err57);
              }
              errors++;
            }
            if (data25.fact_ids === void 0) {
              const err58 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/required", keyword: "required", params: { missingProperty: "fact_ids" }, message: "must have required property 'fact_ids'" };
              if (vErrors === null) {
                vErrors = [err58];
              } else {
                vErrors.push(err58);
              }
              errors++;
            }
            for (const key3 in data25) {
              if (!(key3 === "id" || key3 === "content" || key3 === "topic" || key3 === "sub_topic" || key3 === "source_ids" || key3 === "fact_ids")) {
                const err59 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key3 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err59];
                } else {
                  vErrors.push(err59);
                }
                errors++;
              }
            }
            if (data25.id !== void 0) {
              let data26 = data25.id;
              if (typeof data26 === "string") {
                if (!formats0.test(data26)) {
                  const err60 = { instancePath: instancePath + "/removed/" + i6 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err60];
                  } else {
                    vErrors.push(err60);
                  }
                  errors++;
                }
              } else {
                const err61 = { instancePath: instancePath + "/removed/" + i6 + "/id", schemaPath: "#/components/schemas/HistoricalProfile/properties/id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err61];
                } else {
                  vErrors.push(err61);
                }
                errors++;
              }
            }
            if (data25.content !== void 0) {
              if (typeof data25.content !== "string") {
                const err62 = { instancePath: instancePath + "/removed/" + i6 + "/content", schemaPath: "#/components/schemas/HistoricalProfile/properties/content/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err62];
                } else {
                  vErrors.push(err62);
                }
                errors++;
              }
            }
            if (data25.topic !== void 0) {
              if (typeof data25.topic !== "string") {
                const err63 = { instancePath: instancePath + "/removed/" + i6 + "/topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err63];
                } else {
                  vErrors.push(err63);
                }
                errors++;
              }
            }
            if (data25.sub_topic !== void 0) {
              if (typeof data25.sub_topic !== "string") {
                const err64 = { instancePath: instancePath + "/removed/" + i6 + "/sub_topic", schemaPath: "#/components/schemas/HistoricalProfile/properties/sub_topic/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err64];
                } else {
                  vErrors.push(err64);
                }
                errors++;
              }
            }
            if (data25.source_ids !== void 0) {
              let data30 = data25.source_ids;
              if (Array.isArray(data30)) {
                const len7 = data30.length;
                for (let i7 = 0; i7 < len7; i7++) {
                  if (typeof data30[i7] !== "string") {
                    const err65 = { instancePath: instancePath + "/removed/" + i6 + "/source_ids/" + i7, schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err65];
                    } else {
                      vErrors.push(err65);
                    }
                    errors++;
                  }
                }
              } else {
                const err66 = { instancePath: instancePath + "/removed/" + i6 + "/source_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/source_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err66];
                } else {
                  vErrors.push(err66);
                }
                errors++;
              }
            }
            if (data25.fact_ids !== void 0) {
              let data32 = data25.fact_ids;
              if (Array.isArray(data32)) {
                const len8 = data32.length;
                for (let i8 = 0; i8 < len8; i8++) {
                  let data33 = data32[i8];
                  if (typeof data33 === "string") {
                    if (!formats0.test(data33)) {
                      const err67 = { instancePath: instancePath + "/removed/" + i6 + "/fact_ids/" + i8, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                      if (vErrors === null) {
                        vErrors = [err67];
                      } else {
                        vErrors.push(err67);
                      }
                      errors++;
                    }
                  } else {
                    const err68 = { instancePath: instancePath + "/removed/" + i6 + "/fact_ids/" + i8, schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err68];
                    } else {
                      vErrors.push(err68);
                    }
                    errors++;
                  }
                }
              } else {
                const err69 = { instancePath: instancePath + "/removed/" + i6 + "/fact_ids", schemaPath: "#/components/schemas/HistoricalProfile/properties/fact_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err69];
                } else {
                  vErrors.push(err69);
                }
                errors++;
              }
            }
          } else {
            const err70 = { instancePath: instancePath + "/removed/" + i6, schemaPath: "#/components/schemas/HistoricalProfile/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err70];
            } else {
              vErrors.push(err70);
            }
            errors++;
          }
        }
      } else {
        const err71 = { instancePath: instancePath + "/removed", schemaPath: "#/properties/removed/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err71];
        } else {
          vErrors.push(err71);
        }
        errors++;
      }
    }
  } else {
    const err72 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err72];
    } else {
      vErrors.push(err72);
    }
    errors++;
  }
  validate55.errors = vErrors;
  return errors === 0;
}
validate55.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate54(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate54.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.entries === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "entries" }, message: "must have required property 'entries'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "entries")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.entries !== void 0) {
      let data0 = data.entries;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate55(data0[i0], { instancePath: instancePath + "/entries/" + i0, parentData: data0, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate55.errors : vErrors.concat(validate55.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err2 = { instancePath: instancePath + "/entries", schemaPath: "#/properties/entries/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate54.errors = vErrors;
  return errors === 0;
}
validate54.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate53(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate53.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate54(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate54.errors : vErrors.concat(validate54.errors);
    errors = vErrors.length;
  }
  validate53.errors = vErrors;
  return errors === 0;
}
validate53.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateOperations = validate58;
function validate60(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate60.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operation_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "operation_id" }, message: "must have required property 'operation_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.status === void 0) {
      const err1 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.source_id === void 0) {
      const err2 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "source_id" }, message: "must have required property 'source_id'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.blob_id === void 0) {
      const err3 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "blob_id" }, message: "must have required property 'blob_id'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.result === void 0) {
      const err4 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "result" }, message: "must have required property 'result'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.error === void 0) {
      const err5 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "error" }, message: "must have required property 'error'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "operation_id" || key0 === "status" || key0 === "source_id" || key0 === "blob_id" || key0 === "result" || key0 === "error")) {
        const err6 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err6];
        } else {
          vErrors.push(err6);
        }
        errors++;
      }
    }
    if (data.operation_id !== void 0) {
      let data0 = data.operation_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err7 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
      } else {
        const err8 = { instancePath: instancePath + "/operation_id", schemaPath: "#/properties/operation_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err8];
        } else {
          vErrors.push(err8);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      let data1 = data.status;
      if (typeof data1 !== "string") {
        const err9 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
      if (!(data1 === "processing" || data1 === "completed" || data1 === "failed")) {
        const err10 = { instancePath: instancePath + "/status", schemaPath: "#/properties/status/enum", keyword: "enum", params: { allowedValues: schema35.properties.status.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.source_id !== void 0) {
      if (typeof data.source_id !== "string") {
        const err11 = { instancePath: instancePath + "/source_id", schemaPath: "#/properties/source_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
    if (data.blob_id !== void 0) {
      let data3 = data.blob_id;
      const _errs9 = errors;
      let valid1 = false;
      const _errs10 = errors;
      if (typeof data3 === "string") {
        if (!formats0.test(data3)) {
          const err12 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err12];
          } else {
            vErrors.push(err12);
          }
          errors++;
        }
      } else {
        const err13 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      var _valid0 = _errs10 === errors;
      valid1 = valid1 || _valid0;
      const _errs12 = errors;
      if (data3 !== null) {
        const err14 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      }
      var _valid0 = _errs12 === errors;
      valid1 = valid1 || _valid0;
      if (!valid1) {
        const err15 = { instancePath: instancePath + "/blob_id", schemaPath: "#/properties/blob_id/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      } else {
        errors = _errs9;
        if (vErrors !== null) {
          if (_errs9) {
            vErrors.length = _errs9;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.result !== void 0) {
      let data4 = data.result;
      const _errs15 = errors;
      let valid2 = false;
      const _errs16 = errors;
      if (data4 && typeof data4 == "object" && !Array.isArray(data4)) {
        if (data4.event_ids === void 0) {
          const err16 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/required", keyword: "required", params: { missingProperty: "event_ids" }, message: "must have required property 'event_ids'" };
          if (vErrors === null) {
            vErrors = [err16];
          } else {
            vErrors.push(err16);
          }
          errors++;
        }
        if (data4.profile_ids === void 0) {
          const err17 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/required", keyword: "required", params: { missingProperty: "profile_ids" }, message: "must have required property 'profile_ids'" };
          if (vErrors === null) {
            vErrors = [err17];
          } else {
            vErrors.push(err17);
          }
          errors++;
        }
        for (const key1 in data4) {
          if (!(key1 === "event_ids" || key1 === "profile_ids")) {
            const err18 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err18];
            } else {
              vErrors.push(err18);
            }
            errors++;
          }
        }
        if (data4.event_ids !== void 0) {
          let data5 = data4.event_ids;
          if (Array.isArray(data5)) {
            const len0 = data5.length;
            for (let i0 = 0; i0 < len0; i0++) {
              let data6 = data5[i0];
              if (typeof data6 === "string") {
                if (!formats0.test(data6)) {
                  const err19 = { instancePath: instancePath + "/result/event_ids/" + i0, schemaPath: "#/components/schemas/SourceResult/properties/event_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err19];
                  } else {
                    vErrors.push(err19);
                  }
                  errors++;
                }
              } else {
                const err20 = { instancePath: instancePath + "/result/event_ids/" + i0, schemaPath: "#/components/schemas/SourceResult/properties/event_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err20];
                } else {
                  vErrors.push(err20);
                }
                errors++;
              }
            }
          } else {
            const err21 = { instancePath: instancePath + "/result/event_ids", schemaPath: "#/components/schemas/SourceResult/properties/event_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err21];
            } else {
              vErrors.push(err21);
            }
            errors++;
          }
        }
        if (data4.profile_ids !== void 0) {
          let data7 = data4.profile_ids;
          if (Array.isArray(data7)) {
            const len1 = data7.length;
            for (let i1 = 0; i1 < len1; i1++) {
              let data8 = data7[i1];
              if (typeof data8 === "string") {
                if (!formats0.test(data8)) {
                  const err22 = { instancePath: instancePath + "/result/profile_ids/" + i1, schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/items/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err22];
                  } else {
                    vErrors.push(err22);
                  }
                  errors++;
                }
              } else {
                const err23 = { instancePath: instancePath + "/result/profile_ids/" + i1, schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err23];
                } else {
                  vErrors.push(err23);
                }
                errors++;
              }
            }
          } else {
            const err24 = { instancePath: instancePath + "/result/profile_ids", schemaPath: "#/components/schemas/SourceResult/properties/profile_ids/type", keyword: "type", params: { type: "array" }, message: "must be array" };
            if (vErrors === null) {
              vErrors = [err24];
            } else {
              vErrors.push(err24);
            }
            errors++;
          }
        }
      } else {
        const err25 = { instancePath: instancePath + "/result", schemaPath: "#/components/schemas/SourceResult/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err25];
        } else {
          vErrors.push(err25);
        }
        errors++;
      }
      var _valid1 = _errs16 === errors;
      valid2 = valid2 || _valid1;
      const _errs28 = errors;
      if (data4 !== null) {
        const err26 = { instancePath: instancePath + "/result", schemaPath: "#/properties/result/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err26];
        } else {
          vErrors.push(err26);
        }
        errors++;
      }
      var _valid1 = _errs28 === errors;
      valid2 = valid2 || _valid1;
      if (!valid2) {
        const err27 = { instancePath: instancePath + "/result", schemaPath: "#/properties/result/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err27];
        } else {
          vErrors.push(err27);
        }
        errors++;
      } else {
        errors = _errs15;
        if (vErrors !== null) {
          if (_errs15) {
            vErrors.length = _errs15;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.error !== void 0) {
      let data9 = data.error;
      const _errs31 = errors;
      let valid9 = false;
      const _errs32 = errors;
      if (data9 && typeof data9 == "object" && !Array.isArray(data9)) {
        if (data9.code === void 0) {
          const err28 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/required", keyword: "required", params: { missingProperty: "code" }, message: "must have required property 'code'" };
          if (vErrors === null) {
            vErrors = [err28];
          } else {
            vErrors.push(err28);
          }
          errors++;
        }
        if (data9.retryable === void 0) {
          const err29 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/required", keyword: "required", params: { missingProperty: "retryable" }, message: "must have required property 'retryable'" };
          if (vErrors === null) {
            vErrors = [err29];
          } else {
            vErrors.push(err29);
          }
          errors++;
        }
        for (const key2 in data9) {
          if (!(key2 === "code" || key2 === "retryable")) {
            const err30 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key2 }, message: "must NOT have additional properties" };
            if (vErrors === null) {
              vErrors = [err30];
            } else {
              vErrors.push(err30);
            }
            errors++;
          }
        }
        if (data9.code !== void 0) {
          if (typeof data9.code !== "string") {
            const err31 = { instancePath: instancePath + "/error/code", schemaPath: "#/components/schemas/OperationError/properties/code/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err31];
            } else {
              vErrors.push(err31);
            }
            errors++;
          }
        }
        if (data9.retryable !== void 0) {
          if (typeof data9.retryable !== "boolean") {
            const err32 = { instancePath: instancePath + "/error/retryable", schemaPath: "#/components/schemas/OperationError/properties/retryable/type", keyword: "type", params: { type: "boolean" }, message: "must be boolean" };
            if (vErrors === null) {
              vErrors = [err32];
            } else {
              vErrors.push(err32);
            }
            errors++;
          }
        }
      } else {
        const err33 = { instancePath: instancePath + "/error", schemaPath: "#/components/schemas/OperationError/type", keyword: "type", params: { type: "object" }, message: "must be object" };
        if (vErrors === null) {
          vErrors = [err33];
        } else {
          vErrors.push(err33);
        }
        errors++;
      }
      var _valid2 = _errs32 === errors;
      valid9 = valid9 || _valid2;
      const _errs40 = errors;
      if (data9 !== null) {
        const err34 = { instancePath: instancePath + "/error", schemaPath: "#/properties/error/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err34];
        } else {
          vErrors.push(err34);
        }
        errors++;
      }
      var _valid2 = _errs40 === errors;
      valid9 = valid9 || _valid2;
      if (!valid9) {
        const err35 = { instancePath: instancePath + "/error", schemaPath: "#/properties/error/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err35];
        } else {
          vErrors.push(err35);
        }
        errors++;
      } else {
        errors = _errs31;
        if (vErrors !== null) {
          if (_errs31) {
            vErrors.length = _errs31;
          } else {
            vErrors = null;
          }
        }
      }
    }
  } else {
    const err36 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err36];
    } else {
      vErrors.push(err36);
    }
    errors++;
  }
  validate60.errors = vErrors;
  return errors === 0;
}
validate60.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate59(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate59.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.operations === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "operations" }, message: "must have required property 'operations'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "operations")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.operations !== void 0) {
      let data0 = data.operations;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          if (!validate60(data0[i0], { instancePath: instancePath + "/operations/" + i0, parentData: data0, parentDataProperty: i0, rootData, dynamicAnchors })) {
            vErrors = vErrors === null ? validate60.errors : vErrors.concat(validate60.errors);
            errors = vErrors.length;
          }
        }
      } else {
        const err2 = { instancePath: instancePath + "/operations", schemaPath: "#/properties/operations/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate59.errors = vErrors;
  return errors === 0;
}
validate59.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate58(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate58.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate59(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate59.errors : vErrors.concat(validate59.errors);
    errors = vErrors.length;
  }
  validate58.errors = vErrors;
  return errors === 0;
}
validate58.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateSourcesQuery = validate63;
function validate63(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate63.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.offset !== void 0) {
      let data1 = data.offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate63.errors = vErrors;
  return errors === 0;
}
validate63.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateHistoryQuery = validate64;
function validate64(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate64.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.offset !== void 0) {
      let data1 = data.offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate64.errors = vErrors;
  return errors === 0;
}
validate64.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateOperationsQuery = validate65;
function validate65(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate65.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.offset !== void 0) {
      let data1 = data.offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate65.errors = vErrors;
  return errors === 0;
}
validate65.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProjects = validate66;
function validate67(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate67.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.projects === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "projects" }, message: "must have required property 'projects'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "projects")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.projects !== void 0) {
      let data0 = data.projects;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.project_id === void 0) {
              const err2 = { instancePath: instancePath + "/projects/" + i0, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "project_id" }, message: "must have required property 'project_id'" };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
            if (data1.status === void 0) {
              const err3 = { instancePath: instancePath + "/projects/" + i0, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
              if (vErrors === null) {
                vErrors = [err3];
              } else {
                vErrors.push(err3);
              }
              errors++;
            }
            if (data1.created_at === void 0) {
              const err4 = { instancePath: instancePath + "/projects/" + i0, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            for (const key1 in data1) {
              if (!(key1 === "project_id" || key1 === "status" || key1 === "created_at")) {
                const err5 = { instancePath: instancePath + "/projects/" + i0, schemaPath: "#/components/schemas/ManagedProject/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err5];
                } else {
                  vErrors.push(err5);
                }
                errors++;
              }
            }
            if (data1.project_id !== void 0) {
              if (typeof data1.project_id !== "string") {
                const err6 = { instancePath: instancePath + "/projects/" + i0 + "/project_id", schemaPath: "#/components/schemas/ManagedProject/properties/project_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err6];
                } else {
                  vErrors.push(err6);
                }
                errors++;
              }
            }
            if (data1.status !== void 0) {
              if (typeof data1.status !== "string") {
                const err7 = { instancePath: instancePath + "/projects/" + i0 + "/status", schemaPath: "#/components/schemas/ManagedProject/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err7];
                } else {
                  vErrors.push(err7);
                }
                errors++;
              }
            }
            if (data1.created_at !== void 0) {
              let data4 = data1.created_at;
              if (typeof data4 === "string") {
                if (!formats12.validate(data4)) {
                  const err8 = { instancePath: instancePath + "/projects/" + i0 + "/created_at", schemaPath: "#/components/schemas/ManagedProject/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err8];
                  } else {
                    vErrors.push(err8);
                  }
                  errors++;
                }
              } else {
                const err9 = { instancePath: instancePath + "/projects/" + i0 + "/created_at", schemaPath: "#/components/schemas/ManagedProject/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err9];
                } else {
                  vErrors.push(err9);
                }
                errors++;
              }
            }
          } else {
            const err10 = { instancePath: instancePath + "/projects/" + i0, schemaPath: "#/components/schemas/ManagedProject/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err10];
            } else {
              vErrors.push(err10);
            }
            errors++;
          }
        }
      } else {
        const err11 = { instancePath: instancePath + "/projects", schemaPath: "#/properties/projects/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err11];
        } else {
          vErrors.push(err11);
        }
        errors++;
      }
    }
  } else {
    const err12 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err12];
    } else {
      vErrors.push(err12);
    }
    errors++;
  }
  validate67.errors = vErrors;
  return errors === 0;
}
validate67.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate66(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate66.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate67(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate67.errors : vErrors.concat(validate67.errors);
    errors = vErrors.length;
  }
  validate66.errors = vErrors;
  return errors === 0;
}
validate66.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProject = validate69;
function validate69(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate69.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.project_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "project_id" }, message: "must have required property 'project_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.status === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err2 = { instancePath, schemaPath: "#/components/schemas/ManagedProject/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "project_id" || key0 === "status" || key0 === "created_at")) {
        const err3 = { instancePath, schemaPath: "#/components/schemas/ManagedProject/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
    if (data.project_id !== void 0) {
      if (typeof data.project_id !== "string") {
        const err4 = { instancePath: instancePath + "/project_id", schemaPath: "#/components/schemas/ManagedProject/properties/project_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      if (typeof data.status !== "string") {
        const err5 = { instancePath: instancePath + "/status", schemaPath: "#/components/schemas/ManagedProject/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.created_at !== void 0) {
      let data2 = data.created_at;
      if (typeof data2 === "string") {
        if (!formats12.validate(data2)) {
          const err6 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/ManagedProject/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
      } else {
        const err7 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/ManagedProject/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
  } else {
    const err8 = { instancePath, schemaPath: "#/components/schemas/ManagedProject/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err8];
    } else {
      vErrors.push(err8);
    }
    errors++;
  }
  validate69.errors = vErrors;
  return errors === 0;
}
validate69.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProjectCreate = validate70;
var pattern7 = new RegExp("^[a-zA-Z0-9][a-zA-Z0-9_-]*$", "u");
function validate70(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate70.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.project_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/ProjectCreate/required", keyword: "required", params: { missingProperty: "project_id" }, message: "must have required property 'project_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "project_id")) {
        const err1 = { instancePath, schemaPath: "#/components/schemas/ProjectCreate/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.project_id !== void 0) {
      let data0 = data.project_id;
      if (typeof data0 === "string") {
        if (func1(data0) > 64) {
          const err2 = { instancePath: instancePath + "/project_id", schemaPath: "#/components/schemas/ProjectCreate/properties/project_id/maxLength", keyword: "maxLength", params: { limit: 64 }, message: "must NOT have more than 64 characters" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err3 = { instancePath: instancePath + "/project_id", schemaPath: "#/components/schemas/ProjectCreate/properties/project_id/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        if (!pattern7.test(data0)) {
          const err4 = { instancePath: instancePath + "/project_id", schemaPath: "#/components/schemas/ProjectCreate/properties/project_id/pattern", keyword: "pattern", params: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }, message: 'must match pattern "^[a-zA-Z0-9][a-zA-Z0-9_-]*$"' };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = { instancePath: instancePath + "/project_id", schemaPath: "#/components/schemas/ProjectCreate/properties/project_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/components/schemas/ProjectCreate/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate70.errors = vErrors;
  return errors === 0;
}
validate70.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProjectUpdate = validate71;
var schema88 = { "properties": { "status": { "type": "string", "enum": ["active", "suspended"], "title": "Status" } }, "additionalProperties": false, "type": "object", "required": ["status"], "title": "ProjectUpdate" };
function validate71(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate71.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.status === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/ProjectUpdate/required", keyword: "required", params: { missingProperty: "status" }, message: "must have required property 'status'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "status")) {
        const err1 = { instancePath, schemaPath: "#/components/schemas/ProjectUpdate/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.status !== void 0) {
      let data0 = data.status;
      if (typeof data0 !== "string") {
        const err2 = { instancePath: instancePath + "/status", schemaPath: "#/components/schemas/ProjectUpdate/properties/status/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
      if (!(data0 === "active" || data0 === "suspended")) {
        const err3 = { instancePath: instancePath + "/status", schemaPath: "#/components/schemas/ProjectUpdate/properties/status/enum", keyword: "enum", params: { allowedValues: schema88.properties.status.enum }, message: "must be equal to one of the allowed values" };
        if (vErrors === null) {
          vErrors = [err3];
        } else {
          vErrors.push(err3);
        }
        errors++;
      }
    }
  } else {
    const err4 = { instancePath, schemaPath: "#/components/schemas/ProjectUpdate/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err4];
    } else {
      vErrors.push(err4);
    }
    errors++;
  }
  validate71.errors = vErrors;
  return errors === 0;
}
validate71.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateProjectsQuery = validate72;
function validate72(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate72.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.offset !== void 0) {
      let data1 = data.offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate72.errors = vErrors;
  return errors === 0;
}
validate72.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateKeys = validate73;
var schema92 = { "properties": { "key_id": { "type": "string", "format": "uuid", "title": "Key Id" }, "name": { "type": "string", "title": "Name" }, "scopes": { "items": { "type": "string", "enum": ["read", "write", "admin"] }, "type": "array", "title": "Scopes" }, "expires_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Expires At" }, "revoked_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Revoked At" }, "created_at": { "type": "string", "format": "date-time", "title": "Created At" } }, "additionalProperties": false, "type": "object", "required": ["key_id", "name", "scopes", "expires_at", "revoked_at", "created_at"], "title": "ManagedKey" };
function validate74(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate74.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.keys === void 0) {
      const err0 = { instancePath, schemaPath: "#/required", keyword: "required", params: { missingProperty: "keys" }, message: "must have required property 'keys'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "keys")) {
        const err1 = { instancePath, schemaPath: "#/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.keys !== void 0) {
      let data0 = data.keys;
      if (Array.isArray(data0)) {
        const len0 = data0.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data1 = data0[i0];
          if (data1 && typeof data1 == "object" && !Array.isArray(data1)) {
            if (data1.key_id === void 0) {
              const err2 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "key_id" }, message: "must have required property 'key_id'" };
              if (vErrors === null) {
                vErrors = [err2];
              } else {
                vErrors.push(err2);
              }
              errors++;
            }
            if (data1.name === void 0) {
              const err3 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
              if (vErrors === null) {
                vErrors = [err3];
              } else {
                vErrors.push(err3);
              }
              errors++;
            }
            if (data1.scopes === void 0) {
              const err4 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "scopes" }, message: "must have required property 'scopes'" };
              if (vErrors === null) {
                vErrors = [err4];
              } else {
                vErrors.push(err4);
              }
              errors++;
            }
            if (data1.expires_at === void 0) {
              const err5 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "expires_at" }, message: "must have required property 'expires_at'" };
              if (vErrors === null) {
                vErrors = [err5];
              } else {
                vErrors.push(err5);
              }
              errors++;
            }
            if (data1.revoked_at === void 0) {
              const err6 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "revoked_at" }, message: "must have required property 'revoked_at'" };
              if (vErrors === null) {
                vErrors = [err6];
              } else {
                vErrors.push(err6);
              }
              errors++;
            }
            if (data1.created_at === void 0) {
              const err7 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
              if (vErrors === null) {
                vErrors = [err7];
              } else {
                vErrors.push(err7);
              }
              errors++;
            }
            for (const key1 in data1) {
              if (!(key1 === "key_id" || key1 === "name" || key1 === "scopes" || key1 === "expires_at" || key1 === "revoked_at" || key1 === "created_at")) {
                const err8 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key1 }, message: "must NOT have additional properties" };
                if (vErrors === null) {
                  vErrors = [err8];
                } else {
                  vErrors.push(err8);
                }
                errors++;
              }
            }
            if (data1.key_id !== void 0) {
              let data2 = data1.key_id;
              if (typeof data2 === "string") {
                if (!formats0.test(data2)) {
                  const err9 = { instancePath: instancePath + "/keys/" + i0 + "/key_id", schemaPath: "#/components/schemas/ManagedKey/properties/key_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
                  if (vErrors === null) {
                    vErrors = [err9];
                  } else {
                    vErrors.push(err9);
                  }
                  errors++;
                }
              } else {
                const err10 = { instancePath: instancePath + "/keys/" + i0 + "/key_id", schemaPath: "#/components/schemas/ManagedKey/properties/key_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err10];
                } else {
                  vErrors.push(err10);
                }
                errors++;
              }
            }
            if (data1.name !== void 0) {
              if (typeof data1.name !== "string") {
                const err11 = { instancePath: instancePath + "/keys/" + i0 + "/name", schemaPath: "#/components/schemas/ManagedKey/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err11];
                } else {
                  vErrors.push(err11);
                }
                errors++;
              }
            }
            if (data1.scopes !== void 0) {
              let data4 = data1.scopes;
              if (Array.isArray(data4)) {
                const len1 = data4.length;
                for (let i1 = 0; i1 < len1; i1++) {
                  let data5 = data4[i1];
                  if (typeof data5 !== "string") {
                    const err12 = { instancePath: instancePath + "/keys/" + i0 + "/scopes/" + i1, schemaPath: "#/components/schemas/ManagedKey/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                    if (vErrors === null) {
                      vErrors = [err12];
                    } else {
                      vErrors.push(err12);
                    }
                    errors++;
                  }
                  if (!(data5 === "read" || data5 === "write" || data5 === "admin")) {
                    const err13 = { instancePath: instancePath + "/keys/" + i0 + "/scopes/" + i1, schemaPath: "#/components/schemas/ManagedKey/properties/scopes/items/enum", keyword: "enum", params: { allowedValues: schema92.properties.scopes.items.enum }, message: "must be equal to one of the allowed values" };
                    if (vErrors === null) {
                      vErrors = [err13];
                    } else {
                      vErrors.push(err13);
                    }
                    errors++;
                  }
                }
              } else {
                const err14 = { instancePath: instancePath + "/keys/" + i0 + "/scopes", schemaPath: "#/components/schemas/ManagedKey/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" };
                if (vErrors === null) {
                  vErrors = [err14];
                } else {
                  vErrors.push(err14);
                }
                errors++;
              }
            }
            if (data1.expires_at !== void 0) {
              let data6 = data1.expires_at;
              const _errs17 = errors;
              let valid7 = false;
              const _errs18 = errors;
              if (typeof data6 === "string") {
                if (!formats12.validate(data6)) {
                  const err15 = { instancePath: instancePath + "/keys/" + i0 + "/expires_at", schemaPath: "#/components/schemas/ManagedKey/properties/expires_at/anyOf/0/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err15];
                  } else {
                    vErrors.push(err15);
                  }
                  errors++;
                }
              } else {
                const err16 = { instancePath: instancePath + "/keys/" + i0 + "/expires_at", schemaPath: "#/components/schemas/ManagedKey/properties/expires_at/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err16];
                } else {
                  vErrors.push(err16);
                }
                errors++;
              }
              var _valid0 = _errs18 === errors;
              valid7 = valid7 || _valid0;
              const _errs20 = errors;
              if (data6 !== null) {
                const err17 = { instancePath: instancePath + "/keys/" + i0 + "/expires_at", schemaPath: "#/components/schemas/ManagedKey/properties/expires_at/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err17];
                } else {
                  vErrors.push(err17);
                }
                errors++;
              }
              var _valid0 = _errs20 === errors;
              valid7 = valid7 || _valid0;
              if (!valid7) {
                const err18 = { instancePath: instancePath + "/keys/" + i0 + "/expires_at", schemaPath: "#/components/schemas/ManagedKey/properties/expires_at/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err18];
                } else {
                  vErrors.push(err18);
                }
                errors++;
              } else {
                errors = _errs17;
                if (vErrors !== null) {
                  if (_errs17) {
                    vErrors.length = _errs17;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data1.revoked_at !== void 0) {
              let data7 = data1.revoked_at;
              const _errs23 = errors;
              let valid8 = false;
              const _errs24 = errors;
              if (typeof data7 === "string") {
                if (!formats12.validate(data7)) {
                  const err19 = { instancePath: instancePath + "/keys/" + i0 + "/revoked_at", schemaPath: "#/components/schemas/ManagedKey/properties/revoked_at/anyOf/0/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err19];
                  } else {
                    vErrors.push(err19);
                  }
                  errors++;
                }
              } else {
                const err20 = { instancePath: instancePath + "/keys/" + i0 + "/revoked_at", schemaPath: "#/components/schemas/ManagedKey/properties/revoked_at/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err20];
                } else {
                  vErrors.push(err20);
                }
                errors++;
              }
              var _valid1 = _errs24 === errors;
              valid8 = valid8 || _valid1;
              const _errs26 = errors;
              if (data7 !== null) {
                const err21 = { instancePath: instancePath + "/keys/" + i0 + "/revoked_at", schemaPath: "#/components/schemas/ManagedKey/properties/revoked_at/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
                if (vErrors === null) {
                  vErrors = [err21];
                } else {
                  vErrors.push(err21);
                }
                errors++;
              }
              var _valid1 = _errs26 === errors;
              valid8 = valid8 || _valid1;
              if (!valid8) {
                const err22 = { instancePath: instancePath + "/keys/" + i0 + "/revoked_at", schemaPath: "#/components/schemas/ManagedKey/properties/revoked_at/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
                if (vErrors === null) {
                  vErrors = [err22];
                } else {
                  vErrors.push(err22);
                }
                errors++;
              } else {
                errors = _errs23;
                if (vErrors !== null) {
                  if (_errs23) {
                    vErrors.length = _errs23;
                  } else {
                    vErrors = null;
                  }
                }
              }
            }
            if (data1.created_at !== void 0) {
              let data8 = data1.created_at;
              if (typeof data8 === "string") {
                if (!formats12.validate(data8)) {
                  const err23 = { instancePath: instancePath + "/keys/" + i0 + "/created_at", schemaPath: "#/components/schemas/ManagedKey/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
                  if (vErrors === null) {
                    vErrors = [err23];
                  } else {
                    vErrors.push(err23);
                  }
                  errors++;
                }
              } else {
                const err24 = { instancePath: instancePath + "/keys/" + i0 + "/created_at", schemaPath: "#/components/schemas/ManagedKey/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
                if (vErrors === null) {
                  vErrors = [err24];
                } else {
                  vErrors.push(err24);
                }
                errors++;
              }
            }
          } else {
            const err25 = { instancePath: instancePath + "/keys/" + i0, schemaPath: "#/components/schemas/ManagedKey/type", keyword: "type", params: { type: "object" }, message: "must be object" };
            if (vErrors === null) {
              vErrors = [err25];
            } else {
              vErrors.push(err25);
            }
            errors++;
          }
        }
      } else {
        const err26 = { instancePath: instancePath + "/keys", schemaPath: "#/properties/keys/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err26];
        } else {
          vErrors.push(err26);
        }
        errors++;
      }
    }
  } else {
    const err27 = { instancePath, schemaPath: "#/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err27];
    } else {
      vErrors.push(err27);
    }
    errors++;
  }
  validate74.errors = vErrors;
  return errors === 0;
}
validate74.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
function validate73(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate73.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (!validate74(data, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors })) {
    vErrors = vErrors === null ? validate74.errors : vErrors.concat(validate74.errors);
    errors = vErrors.length;
  }
  validate73.errors = vErrors;
  return errors === 0;
}
validate73.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateKeysQuery = validate76;
function validate76(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate76.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    for (const key0 in data) {
      if (!(key0 === "limit" || key0 === "offset")) {
        const err0 = { instancePath, schemaPath: "#/allOf/0/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err0];
        } else {
          vErrors.push(err0);
        }
        errors++;
      }
    }
    if (data.limit !== void 0) {
      let data0 = data.limit;
      if (!(typeof data0 == "number" && (!(data0 % 1) && !isNaN(data0)))) {
        const err1 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
      if (typeof data0 == "number") {
        if (data0 > 100 || isNaN(data0)) {
          const err2 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/maximum", keyword: "maximum", params: { comparison: "<=", limit: 100 }, message: "must be <= 100" };
          if (vErrors === null) {
            vErrors = [err2];
          } else {
            vErrors.push(err2);
          }
          errors++;
        }
        if (data0 < 1 || isNaN(data0)) {
          const err3 = { instancePath: instancePath + "/limit", schemaPath: "#/allOf/0/properties/limit/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 }, message: "must be >= 1" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
      }
    }
    if (data.offset !== void 0) {
      let data1 = data.offset;
      if (!(typeof data1 == "number" && (!(data1 % 1) && !isNaN(data1)))) {
        const err4 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/type", keyword: "type", params: { type: "integer" }, message: "must be integer" };
        if (vErrors === null) {
          vErrors = [err4];
        } else {
          vErrors.push(err4);
        }
        errors++;
      }
      if (typeof data1 == "number") {
        if (data1 < 0 || isNaN(data1)) {
          const err5 = { instancePath: instancePath + "/offset", schemaPath: "#/allOf/0/properties/offset/minimum", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" };
          if (vErrors === null) {
            vErrors = [err5];
          } else {
            vErrors.push(err5);
          }
          errors++;
        }
      }
    }
  } else {
    const err6 = { instancePath, schemaPath: "#/allOf/0/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err6];
    } else {
      vErrors.push(err6);
    }
    errors++;
  }
  validate76.errors = vErrors;
  return errors === 0;
}
validate76.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateKeyCreate = validate77;
var schema95 = { "properties": { "name": { "type": "string", "maxLength": 128, "minLength": 1, "title": "Name" }, "scopes": { "items": { "type": "string", "enum": ["read", "write", "admin"] }, "type": "array", "maxItems": 3, "minItems": 1, "title": "Scopes" }, "expires_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Expires At" } }, "additionalProperties": false, "type": "object", "required": ["name", "scopes"], "title": "KeyCreate" };
function validate77(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate77.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.name === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/KeyCreate/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.scopes === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/KeyCreate/required", keyword: "required", params: { missingProperty: "scopes" }, message: "must have required property 'scopes'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "name" || key0 === "scopes" || key0 === "expires_at")) {
        const err2 = { instancePath, schemaPath: "#/components/schemas/KeyCreate/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      let data0 = data.name;
      if (typeof data0 === "string") {
        if (func1(data0) > 128) {
          const err3 = { instancePath: instancePath + "/name", schemaPath: "#/components/schemas/KeyCreate/properties/name/maxLength", keyword: "maxLength", params: { limit: 128 }, message: "must NOT have more than 128 characters" };
          if (vErrors === null) {
            vErrors = [err3];
          } else {
            vErrors.push(err3);
          }
          errors++;
        }
        if (func1(data0) < 1) {
          const err4 = { instancePath: instancePath + "/name", schemaPath: "#/components/schemas/KeyCreate/properties/name/minLength", keyword: "minLength", params: { limit: 1 }, message: "must NOT have fewer than 1 characters" };
          if (vErrors === null) {
            vErrors = [err4];
          } else {
            vErrors.push(err4);
          }
          errors++;
        }
      } else {
        const err5 = { instancePath: instancePath + "/name", schemaPath: "#/components/schemas/KeyCreate/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err5];
        } else {
          vErrors.push(err5);
        }
        errors++;
      }
    }
    if (data.scopes !== void 0) {
      let data1 = data.scopes;
      if (Array.isArray(data1)) {
        if (data1.length > 3) {
          const err6 = { instancePath: instancePath + "/scopes", schemaPath: "#/components/schemas/KeyCreate/properties/scopes/maxItems", keyword: "maxItems", params: { limit: 3 }, message: "must NOT have more than 3 items" };
          if (vErrors === null) {
            vErrors = [err6];
          } else {
            vErrors.push(err6);
          }
          errors++;
        }
        if (data1.length < 1) {
          const err7 = { instancePath: instancePath + "/scopes", schemaPath: "#/components/schemas/KeyCreate/properties/scopes/minItems", keyword: "minItems", params: { limit: 1 }, message: "must NOT have fewer than 1 items" };
          if (vErrors === null) {
            vErrors = [err7];
          } else {
            vErrors.push(err7);
          }
          errors++;
        }
        const len0 = data1.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data2 = data1[i0];
          if (typeof data2 !== "string") {
            const err8 = { instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/components/schemas/KeyCreate/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err8];
            } else {
              vErrors.push(err8);
            }
            errors++;
          }
          if (!(data2 === "read" || data2 === "write" || data2 === "admin")) {
            const err9 = { instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/components/schemas/KeyCreate/properties/scopes/items/enum", keyword: "enum", params: { allowedValues: schema95.properties.scopes.items.enum }, message: "must be equal to one of the allowed values" };
            if (vErrors === null) {
              vErrors = [err9];
            } else {
              vErrors.push(err9);
            }
            errors++;
          }
        }
      } else {
        const err10 = { instancePath: instancePath + "/scopes", schemaPath: "#/components/schemas/KeyCreate/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.expires_at !== void 0) {
      let data3 = data.expires_at;
      const _errs11 = errors;
      let valid5 = false;
      const _errs12 = errors;
      if (typeof data3 === "string") {
        if (!formats12.validate(data3)) {
          const err11 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/KeyCreate/properties/expires_at/anyOf/0/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err11];
          } else {
            vErrors.push(err11);
          }
          errors++;
        }
      } else {
        const err12 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/KeyCreate/properties/expires_at/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err12];
        } else {
          vErrors.push(err12);
        }
        errors++;
      }
      var _valid0 = _errs12 === errors;
      valid5 = valid5 || _valid0;
      const _errs14 = errors;
      if (data3 !== null) {
        const err13 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/KeyCreate/properties/expires_at/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
      var _valid0 = _errs14 === errors;
      valid5 = valid5 || _valid0;
      if (!valid5) {
        const err14 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/KeyCreate/properties/expires_at/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err14];
        } else {
          vErrors.push(err14);
        }
        errors++;
      } else {
        errors = _errs11;
        if (vErrors !== null) {
          if (_errs11) {
            vErrors.length = _errs11;
          } else {
            vErrors = null;
          }
        }
      }
    }
  } else {
    const err15 = { instancePath, schemaPath: "#/components/schemas/KeyCreate/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err15];
    } else {
      vErrors.push(err15);
    }
    errors++;
  }
  validate77.errors = vErrors;
  return errors === 0;
}
validate77.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateIssuedKey = validate78;
var schema97 = { "properties": { "key_id": { "type": "string", "format": "uuid", "title": "Key Id" }, "name": { "type": "string", "title": "Name" }, "scopes": { "items": { "type": "string", "enum": ["read", "write", "admin"] }, "type": "array", "title": "Scopes" }, "expires_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Expires At" }, "revoked_at": { "anyOf": [{ "type": "string", "format": "date-time" }, { "type": "null" }], "title": "Revoked At" }, "created_at": { "type": "string", "format": "date-time", "title": "Created At" }, "token": { "type": "string", "title": "Token" } }, "additionalProperties": false, "type": "object", "required": ["key_id", "name", "scopes", "expires_at", "revoked_at", "created_at", "token"], "title": "IssuedKey" };
function validate78(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate78.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.key_id === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "key_id" }, message: "must have required property 'key_id'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    if (data.name === void 0) {
      const err1 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "name" }, message: "must have required property 'name'" };
      if (vErrors === null) {
        vErrors = [err1];
      } else {
        vErrors.push(err1);
      }
      errors++;
    }
    if (data.scopes === void 0) {
      const err2 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "scopes" }, message: "must have required property 'scopes'" };
      if (vErrors === null) {
        vErrors = [err2];
      } else {
        vErrors.push(err2);
      }
      errors++;
    }
    if (data.expires_at === void 0) {
      const err3 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "expires_at" }, message: "must have required property 'expires_at'" };
      if (vErrors === null) {
        vErrors = [err3];
      } else {
        vErrors.push(err3);
      }
      errors++;
    }
    if (data.revoked_at === void 0) {
      const err4 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "revoked_at" }, message: "must have required property 'revoked_at'" };
      if (vErrors === null) {
        vErrors = [err4];
      } else {
        vErrors.push(err4);
      }
      errors++;
    }
    if (data.created_at === void 0) {
      const err5 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "created_at" }, message: "must have required property 'created_at'" };
      if (vErrors === null) {
        vErrors = [err5];
      } else {
        vErrors.push(err5);
      }
      errors++;
    }
    if (data.token === void 0) {
      const err6 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/required", keyword: "required", params: { missingProperty: "token" }, message: "must have required property 'token'" };
      if (vErrors === null) {
        vErrors = [err6];
      } else {
        vErrors.push(err6);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "key_id" || key0 === "name" || key0 === "scopes" || key0 === "expires_at" || key0 === "revoked_at" || key0 === "created_at" || key0 === "token")) {
        const err7 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err7];
        } else {
          vErrors.push(err7);
        }
        errors++;
      }
    }
    if (data.key_id !== void 0) {
      let data0 = data.key_id;
      if (typeof data0 === "string") {
        if (!formats0.test(data0)) {
          const err8 = { instancePath: instancePath + "/key_id", schemaPath: "#/components/schemas/IssuedKey/properties/key_id/format", keyword: "format", params: { format: "uuid" }, message: 'must match format "uuid"' };
          if (vErrors === null) {
            vErrors = [err8];
          } else {
            vErrors.push(err8);
          }
          errors++;
        }
      } else {
        const err9 = { instancePath: instancePath + "/key_id", schemaPath: "#/components/schemas/IssuedKey/properties/key_id/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err9];
        } else {
          vErrors.push(err9);
        }
        errors++;
      }
    }
    if (data.name !== void 0) {
      if (typeof data.name !== "string") {
        const err10 = { instancePath: instancePath + "/name", schemaPath: "#/components/schemas/IssuedKey/properties/name/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err10];
        } else {
          vErrors.push(err10);
        }
        errors++;
      }
    }
    if (data.scopes !== void 0) {
      let data2 = data.scopes;
      if (Array.isArray(data2)) {
        const len0 = data2.length;
        for (let i0 = 0; i0 < len0; i0++) {
          let data3 = data2[i0];
          if (typeof data3 !== "string") {
            const err11 = { instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/components/schemas/IssuedKey/properties/scopes/items/type", keyword: "type", params: { type: "string" }, message: "must be string" };
            if (vErrors === null) {
              vErrors = [err11];
            } else {
              vErrors.push(err11);
            }
            errors++;
          }
          if (!(data3 === "read" || data3 === "write" || data3 === "admin")) {
            const err12 = { instancePath: instancePath + "/scopes/" + i0, schemaPath: "#/components/schemas/IssuedKey/properties/scopes/items/enum", keyword: "enum", params: { allowedValues: schema97.properties.scopes.items.enum }, message: "must be equal to one of the allowed values" };
            if (vErrors === null) {
              vErrors = [err12];
            } else {
              vErrors.push(err12);
            }
            errors++;
          }
        }
      } else {
        const err13 = { instancePath: instancePath + "/scopes", schemaPath: "#/components/schemas/IssuedKey/properties/scopes/type", keyword: "type", params: { type: "array" }, message: "must be array" };
        if (vErrors === null) {
          vErrors = [err13];
        } else {
          vErrors.push(err13);
        }
        errors++;
      }
    }
    if (data.expires_at !== void 0) {
      let data4 = data.expires_at;
      const _errs13 = errors;
      let valid5 = false;
      const _errs14 = errors;
      if (typeof data4 === "string") {
        if (!formats12.validate(data4)) {
          const err14 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/IssuedKey/properties/expires_at/anyOf/0/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err14];
          } else {
            vErrors.push(err14);
          }
          errors++;
        }
      } else {
        const err15 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/IssuedKey/properties/expires_at/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err15];
        } else {
          vErrors.push(err15);
        }
        errors++;
      }
      var _valid0 = _errs14 === errors;
      valid5 = valid5 || _valid0;
      const _errs16 = errors;
      if (data4 !== null) {
        const err16 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/IssuedKey/properties/expires_at/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err16];
        } else {
          vErrors.push(err16);
        }
        errors++;
      }
      var _valid0 = _errs16 === errors;
      valid5 = valid5 || _valid0;
      if (!valid5) {
        const err17 = { instancePath: instancePath + "/expires_at", schemaPath: "#/components/schemas/IssuedKey/properties/expires_at/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err17];
        } else {
          vErrors.push(err17);
        }
        errors++;
      } else {
        errors = _errs13;
        if (vErrors !== null) {
          if (_errs13) {
            vErrors.length = _errs13;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.revoked_at !== void 0) {
      let data5 = data.revoked_at;
      const _errs19 = errors;
      let valid6 = false;
      const _errs20 = errors;
      if (typeof data5 === "string") {
        if (!formats12.validate(data5)) {
          const err18 = { instancePath: instancePath + "/revoked_at", schemaPath: "#/components/schemas/IssuedKey/properties/revoked_at/anyOf/0/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err18];
          } else {
            vErrors.push(err18);
          }
          errors++;
        }
      } else {
        const err19 = { instancePath: instancePath + "/revoked_at", schemaPath: "#/components/schemas/IssuedKey/properties/revoked_at/anyOf/0/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err19];
        } else {
          vErrors.push(err19);
        }
        errors++;
      }
      var _valid1 = _errs20 === errors;
      valid6 = valid6 || _valid1;
      const _errs22 = errors;
      if (data5 !== null) {
        const err20 = { instancePath: instancePath + "/revoked_at", schemaPath: "#/components/schemas/IssuedKey/properties/revoked_at/anyOf/1/type", keyword: "type", params: { type: "null" }, message: "must be null" };
        if (vErrors === null) {
          vErrors = [err20];
        } else {
          vErrors.push(err20);
        }
        errors++;
      }
      var _valid1 = _errs22 === errors;
      valid6 = valid6 || _valid1;
      if (!valid6) {
        const err21 = { instancePath: instancePath + "/revoked_at", schemaPath: "#/components/schemas/IssuedKey/properties/revoked_at/anyOf", keyword: "anyOf", params: {}, message: "must match a schema in anyOf" };
        if (vErrors === null) {
          vErrors = [err21];
        } else {
          vErrors.push(err21);
        }
        errors++;
      } else {
        errors = _errs19;
        if (vErrors !== null) {
          if (_errs19) {
            vErrors.length = _errs19;
          } else {
            vErrors = null;
          }
        }
      }
    }
    if (data.created_at !== void 0) {
      let data6 = data.created_at;
      if (typeof data6 === "string") {
        if (!formats12.validate(data6)) {
          const err22 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/IssuedKey/properties/created_at/format", keyword: "format", params: { format: "date-time" }, message: 'must match format "date-time"' };
          if (vErrors === null) {
            vErrors = [err22];
          } else {
            vErrors.push(err22);
          }
          errors++;
        }
      } else {
        const err23 = { instancePath: instancePath + "/created_at", schemaPath: "#/components/schemas/IssuedKey/properties/created_at/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err23];
        } else {
          vErrors.push(err23);
        }
        errors++;
      }
    }
    if (data.token !== void 0) {
      if (typeof data.token !== "string") {
        const err24 = { instancePath: instancePath + "/token", schemaPath: "#/components/schemas/IssuedKey/properties/token/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err24];
        } else {
          vErrors.push(err24);
        }
        errors++;
      }
    }
  } else {
    const err25 = { instancePath, schemaPath: "#/components/schemas/IssuedKey/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err25];
    } else {
      vErrors.push(err25);
    }
    errors++;
  }
  validate78.errors = vErrors;
  return errors === 0;
}
validate78.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
var validateLegacyToken = validate79;
function validate79(data, { instancePath = "", parentData, parentDataProperty, rootData = data, dynamicAnchors = {} } = {}) {
  ;
  let vErrors = null;
  let errors = 0;
  const evaluated0 = validate79.evaluated;
  if (evaluated0.dynamicProps) {
    evaluated0.props = void 0;
  }
  if (evaluated0.dynamicItems) {
    evaluated0.items = void 0;
  }
  if (data && typeof data == "object" && !Array.isArray(data)) {
    if (data.token === void 0) {
      const err0 = { instancePath, schemaPath: "#/components/schemas/LegacyToken/required", keyword: "required", params: { missingProperty: "token" }, message: "must have required property 'token'" };
      if (vErrors === null) {
        vErrors = [err0];
      } else {
        vErrors.push(err0);
      }
      errors++;
    }
    for (const key0 in data) {
      if (!(key0 === "token")) {
        const err1 = { instancePath, schemaPath: "#/components/schemas/LegacyToken/additionalProperties", keyword: "additionalProperties", params: { additionalProperty: key0 }, message: "must NOT have additional properties" };
        if (vErrors === null) {
          vErrors = [err1];
        } else {
          vErrors.push(err1);
        }
        errors++;
      }
    }
    if (data.token !== void 0) {
      if (typeof data.token !== "string") {
        const err2 = { instancePath: instancePath + "/token", schemaPath: "#/components/schemas/LegacyToken/properties/token/type", keyword: "type", params: { type: "string" }, message: "must be string" };
        if (vErrors === null) {
          vErrors = [err2];
        } else {
          vErrors.push(err2);
        }
        errors++;
      }
    }
  } else {
    const err3 = { instancePath, schemaPath: "#/components/schemas/LegacyToken/type", keyword: "type", params: { type: "object" }, message: "must be object" };
    if (vErrors === null) {
      vErrors = [err3];
    } else {
      vErrors.push(err3);
    }
    errors++;
  }
  validate79.errors = vErrors;
  return errors === 0;
}
validate79.evaluated = { "props": true, "dynamicProps": false, "dynamicItems": false };
export {
  validateBlob,
  validateForgetUserPath,
  validateForgottenUser,
  validateHistory,
  validateHistoryQuery,
  validateImport,
  validateIssuedKey,
  validateKeyCreate,
  validateKeys,
  validateKeysQuery,
  validateLegacyToken,
  validateMessageDeletion,
  validateOperation,
  validateOperations,
  validateOperationsQuery,
  validateProfiles,
  validateProject,
  validateProjectCreate,
  validateProjectUpdate,
  validateProjects,
  validateProjectsQuery,
  validateSearch,
  validateSource,
  validateSourceQuery,
  validateSources,
  validateSourcesQuery
};
