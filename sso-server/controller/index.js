const uuidv4 = require("uuid/v4");
const Hashids = require("hashids");
const URL = require("url").URL;
const hashids = new Hashids();
const { genJwtToken } = require("./jwt_helper");

const re = /(\S+)\s+(\S+)/;

// Note: express http converts all headers
// to lower case.
const AUTH_HEADER = "authorization";
const BEARER_AUTH_SCHEME = "bearer";

function parseAuthHeader(hdrValue) {
  if (typeof hdrValue !== "string") {
    return null;
  }
  const matches = hdrValue.match(re);
  return matches && { scheme: matches[1], value: matches[2] };
}

const fromAuthHeaderWithScheme = function(authScheme) {
  const authSchemeLower = authScheme.toLowerCase();
  return function(request) {
    let token = null;
    if (request.headers[AUTH_HEADER]) {
      const authParams = parseAuthHeader(request.headers[AUTH_HEADER]);
      if (authParams && authSchemeLower === authParams.scheme.toLowerCase()) {
        token = authParams.value;
      }
    }
    return token;
  };
};

const fromAuthHeaderAsBearerToken = function() {
  return fromAuthHeaderWithScheme(BEARER_AUTH_SCHEME);
};

const appTokenFromRequest = fromAuthHeaderAsBearerToken();

// app token to validate the request is coming from the authenticated server only.
const appTokenDB = {
  sso_consumer: "l1Q7zkOL59cRqWBkQ12ZiGVW2DBL",
  simple_sso_consumer: "1g0jJwGmRQhJwvwNOrY4i90kD0m"
};

const alloweOrigin = {
  "http://consumer.ankuranand.in:3020": true,
  "http://consumertwo.ankuranand.in:3030": true,
  "http://sso.ankuranand.in:3080": false
};

const deHyphenatedUUID = () => uuidv4().replace(/-/gi, "");
const encodedId = () => hashids.encodeHex(deHyphenatedUUID());

// A temporary cahce to store all the application that has login using the current session.
// It can be useful for variuos audit purpose
const sessionUser = {};
const sessionApp = {};

const originAppName = {
  "http://consumer.ankuranand.in:3020": "sso_consumer",
  "http://consumertwo.ankuranand.in:3030": "simple_sso_consumer"
};

const userDB = {
  "info@ankuranand.com": {
    password: "test",
    userId: encodedId(), // incase you dont want to share the user-email.
    appPolicy: {
      sso_consumer: { role: "admin", shareEmail: true },
      simple_sso_consumer: { role: "user", shareEmail: false }
    }
  }
};

// these token are for the validation purpose
const intrmTokenCache = {};

const fillIntrmTokenCache = (origin, id, intrmToken) => {
  intrmTokenCache[intrmToken] = [id, originAppName[origin]];
};
const storeApplicationInCache = (origin, id, intrmToken) => {
  if (sessionApp[id] == null) {
    sessionApp[id] = {
      [originAppName[origin]]: true
    };
    fillIntrmTokenCache(origin, id, intrmToken);
  } else {
    sessionApp[id][originAppName[origin]] = true;
    fillIntrmTokenCache(origin, id, intrmToken);
  }
  console.log({ ...sessionApp }, { ...sessionUser }, { intrmTokenCache });
};

const generatePayload = ssoToken => {
  const globalSessionToken = intrmTokenCache[ssoToken][0];
  const appName = intrmTokenCache[ssoToken][1];
  const userEmail = sessionUser[globalSessionToken];
  const user = userDB[userEmail];
  const appPolicy = user.appPolicy[appName];
  const email = appPolicy.shareEmail === true ? userEmail : undefined;
  const payload = {
    ...{ ...appPolicy },
    ...{
      email,
      shareEmail: undefined,
      uid: user.userId,
      // global SessionID for the logout functionality.
      globalSessionID: globalSessionToken
    }
  };
  return payload;
};

const verifySsoToken = async (req, res, next) => {
  const appToken = appTokenFromRequest(req);
  const { ssoToken } = req.query;
  // if the application token is not present or ssoToken request is invalid
  // if the ssoToken is not present in the cache some is
  // smart.
  if (
    appToken == null ||
    ssoToken == null ||
    intrmTokenCache[ssoToken] == null
  ) {
    return res.status(400).json({ message: "badRequest" });
  }

  // if the appToken is present and check if it's valid for the application
  const appName = intrmTokenCache[ssoToken][1];
  const globalSessionToken = intrmTokenCache[ssoToken][0];
  // If the appToken is not equal to token given during the sso app registraion or later stage than invalid
  if (
    appToken !== appTokenDB[appName] ||
    sessionApp[globalSessionToken][appName] !== true
  ) {
    return res.status(403).json({ message: "Unauthorized" });
  }
  // checking if the token passed has been generated
  const payload = generatePayload(ssoToken);

  const token = await genJwtToken(payload);
  // delete the itremCache key for no futher use,
  delete intrmTokenCache[ssoToken];
  return res.status(200).json({ token });
};
const doLogin = (req, res, next) => {
  // do the validation with email and password
  // but the goal is not to do the same in this right now,
  // like checking with Datebase and all, we are skiping these section
  const { email, password } = req.body;
  search(email, password).then(result => {
    userDB[`${email}`]= {
      password: password,
      userId: encodedId(), // incase you dont want to share the user-email.
      appPolicy: {
        sso_consumer: { role: "admin", shareEmail: true },
        simple_sso_consumer: { role: "user", shareEmail: false }
      }
    }
  
    const { serviceURL } = req.query;
    const id = encodedId();
    req.session.user = id;
    console.log("session is filled")
    console.log(req.session)
    sessionUser[id] = email;
    if (serviceURL == null) {
      return res.redirect("/");
    }
    const url = new URL(serviceURL);
    const intrmid = encodedId();
    storeApplicationInCache(url.origin, id, intrmid);
    console.log("going : "+`${serviceURL}?ssoToken=${intrmid}`)
    return res.redirect(`${serviceURL}?ssoToken=${intrmid}`);
  }).catch(err => {
    console.log(err)
    return res.status(404).json({ message: "Invalid email and password" });
  })
};

const login = (req, res, next) => {
  // The req.query will have the redirect url where we need to redirect after successful
  // login and with sso token.
  // This can also be used to verify the origin from where the request has came in
  // for the redirection
  const { serviceURL } = req.query;
  // direct access will give the error inside new URL.
  if (serviceURL != null) {
    const url = new URL(serviceURL);
    if (alloweOrigin[url.origin] !== true) {
      return res
        .status(400)
        .json({ message: "Your are not allowed to access the sso-server" });
    }
  }
  if (req.session.user != null && serviceURL == null) {
    return res.redirect("/");
  }
  // if global session already has the user directly redirect with the token
  if (req.session.user != null && serviceURL != null) {
    const url = new URL(serviceURL);
    const intrmid = encodedId();
    storeApplicationInCache(url.origin, req.session.user, intrmid);
    return res.redirect(`${serviceURL}?ssoToken=${intrmid}`);
  }

  return res.render("login", {
    title: "SSO-Server | Login"
  });
};

async function search(username, password) {
  return new Promise(async (res, rej) => {
    console.log("user:"+username+" passwd:"+password)
    var result = "";    // To send back to the client

    var client = ldap.createClient({
      url: "ldap://193.176.243.52:389/"
    });
    console.log("cn=admin,dc=mycompany,dc=com" + "   " + "admin")
    client.bind("cn=admin,dc=mycompany,dc=com","admin", function (err) {
      if (err) {
        result += "Reader bind failed " + err;
        //res.send(result);
        console.log(result)
        rej()
      }

      result += "Reader bind succeeded\n";
      console.log(result)
      var filter = `(uid=${username})`;
      var base = 'cn=Bill Gates,ou=users,dc=mycompany,dc=com';
      result += `LDAP filter: ${filter}\n`;
      console.log(result)
      client.search(base, { filter: filter, scope: "sub" },
        (err, searchRes) => {
          var searchList = [];

          if (err) {
            result += "Search failed " + err;
            console.log(result)
            //res.send(result);
            rej()
          }

          searchRes.on("searchEntry", (entry) => {
            result += "Found entry: " + entry + "\n";
            searchList.push(entry);
          });

          searchRes.on("error", (err) => {
            result += "Search failed with " + err;
            console.log(result)
            // res.send(result);
            rej()
          });

          searchRes.on("end", (retVal) => {
            result += "Search results length: " + searchList.length + "\n";
            for (var i = 0; i < searchList.length; i++)
              result += "DN:" + searchList[i].objectName + "\n";
            result += "Search retval:" + retVal + "\n";

            if (searchList.length === 1) {
              client.bind(searchList[0].objectName, password, function (err) {
                if (err) {
                  result += "Bind with real credential error: " + err;
                  console.log(result)
                  rej()
                }

                else {
                  result += "Bind with real credential is a success";
                  console.log(result)
                  res()
                }


                // res.send(result);
              });  // client.bind (real credential)


            } else { // if (searchList.length === 1)
              result += "No unique user to bind";
              console.log(result)
              rej()
              //res.send(result);
            }

          });   // searchRes.on("end",...)

        });   // client.search

    }); // client.bind  (reader account)
  })

}

module.exports = Object.assign({}, { doLogin, login, verifySsoToken });
