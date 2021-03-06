var express = require('express');
var bodyParser = require('body-parser');
var app = express();

var config = require('./config.json'),
    ArcNode = require('arc-node'),
    ArcJSON = require('arcgis-json-objects'),
    service = new ArcNode(config);

var sensors = {};
var oids = {};

app.use('/static', express.static('data'));
app.use( bodyParser.json() );


service.getToken().then(function(response){
    
    if(response.error){
        console.log("Response: %s", JSON.stringify(response.error));
    }else{
        var server = app.listen(config.listener_port, function () {
            var host = server.address().address;
            var port = server.address().port;

            console.log('fiware_agol listening at http://%s:%s', host, port);
        });
        
        // Init all sensors's feature services
        for (key in config.sensors) {
            if (config.sensors.hasOwnProperty(key)) {
                initFeatureService(config.sensors[key]);
            }
        }

        var key;
        for (key in config.sensors) {
            if (config.sensors.hasOwnProperty(key)) {
                (function(key){
                    s = config.sensors[key];
                    console.log("Listening at: %s", s.route);
                    app.post(s.route, function (req, res) {
                        sendToArcGIS(config.sensors[key], req, res);
                    });
                })(key);
            }
        }
    }
});



/************************************************************
 *
 *   This takes a ContextBroker notification and sends it to ArcGIS Online
 *
 ************************************************************/
var sendToArcGIS = function (sensorDetails, req, res) {
    var attributes, aux, sensor, i, j, numSensors, addData, updateData, timeInstant, feature, attrsLen, attrName, x, y;

    // Add to sensors one object for each sensor
    numSensors = req.body.contextResponses.length;
    sensors={};

    // Clean data
    for(j=0; j< numSensors;j++){
        sensor = req.body.contextResponses[j];
        attributes = {};
        attributes["id"] = sensor.contextElement.id;
        aux = sensor.contextElement.attributes;
        for(i=0; i < aux.length; i++){
            attributes[aux[i].name] = aux[i].value;
        }
        sensors[attributes["id"]] = attributes
    }

    // Transform data to features
    addData = [];
    updateData = [];
    attrsLen = sensorDetails.fields.length;
    for (var key in sensors) {
        if (sensors.hasOwnProperty(key)) {
            sensor = sensors[key];

            // Get sensor location
            if(sensor["location"]){
                aux = sensor["location"].split(",");
                y = aux[0];
                x = aux[1];
            }else if(sensor["position"]){
                aux = sensor["position"].split(",");
                y = aux[0];
                x = aux[1];
            }else if(sensor["Longitud"] && sensor["Latitud"]) {
                x = sensor["Longitud"];
                y = sensor["Latitud"];
            }else{
                console.log("Error: this is not a geolocated sensor");
                res.send("Error: this is not a geolocated sensor");
                return -1;
            }

            // Format time to Date format
            timeInstant = parseDate(sensor["TimeInstant"]);
            feature = {
                "attributes":{
                    id: key,
                    "TimeInstant": timeInstant
                },
                "geometry": {
                    "x": x,
                    "y": y,
                    "spatialReference": {"wkid" : 4326}
                }
            };

            for(i = 0 ; i < attrsLen ; i++){
                attrName = sensorDetails.fields[i][0];
                feature.attributes[attrName] = sensor[attrName];
            }
	    if(oids[key]){
                //Update
                console.log("Feature to update = "+key+" (has OBJECTID = "+oids[key]+")");
                //Include "OBJECTID"
                feature.attributes["OBJECTID"]=oids[key];
                updateData.push(feature);
			}else{
                //add
                console.log("Feature to add = "+key);
                addData.push(feature);
            }
        }
    }
    if(addData.length>0){
        service.addFeatures({
            serviceName: sensorDetails.serviceName,
            layer: "0",
            features: addData
        }).then(function(response){
            console.log("New features added");
    	    console.log("Features added\nresponse = ", JSON.stringify(response, null, "\t"));
            console.log("Added OIDs");
    	    for(var i= 0; i < addData.length; i++){
    	    	oids[addData[i].attributes.id]=response.addResults[i].objectId;
	        console.log(addData[i].attributes.id+" => "+response.addResults[i].objectId);
    	    }
            res.send(response);
        },function(e){
            console.log("Error: ", e);
            res.send(e.message);
        });
    }
    if(updateData.length>0){
        service.updateFeatures({
            serviceName: sensorDetails.serviceName,
            layer: "0",
            features: updateData
        }).then(function(response){
            console.log("Features updated\nresponse = ", JSON.stringify(response, null, "\t"));
            res.send(response);
        },function(e){
            console.log("Error: ", e);
            res.send(e.message);
        });
    }
};

/************************************************************
 *
 *   This function checks if a Feature Service exists, otherwise
 *   if handles all the request to create a new one with an empty layer
 *
 ************************************************************/
var initFeatureService = function(sensor){
    var options = {
        serviceName: sensor.serviceName
    };

    console.log("Check if Feature Service exists:", sensor.serviceName);
    service.checkIfFSExists(options).then(function(response){

        if(response.available){
            console.log("Creating feature service %s", sensor.serviceName);
            service.createFeatureService({name: sensor.serviceName}).then(function(response){

                var fields, layer, len, i;

                console.log("No, new Feature Service added:", response.encodedServiceURL);

                // Load fields with sensor attributes
                fields = [ArcJSON.field({
                    "name": "OBJECTID",
                    "type": "esriFieldTypeOID",
                    "nullable": false,
                    "editable": false
                })];

                len = sensor.fields.length;

                for(i = 0 ; i < len ; i++){
                    fields.push(ArcJSON.field({
                        "name": sensor.fields[i][0],
                        "type": sensor.fields[i][1]
                    }));
                }

                layer = ArcJSON.featureLayer({
                    name: sensor.serviceName,
                    fields: fields
                });

                service.addLayersToFS({
                    service: response.encodedServiceURL,
                    layers: [layer]
                }).then(function(response){
                    console.log("Service initialized: ", sensor.serviceName);
                },function(e){
                    console.log("Error: ", e);
                });

            },function(e){
                console.log("Error: ", e);
            });
        }else{
            console.log("Yes, service initialized: ", sensor.serviceName);
			if(sensor.whereClause){
    			service.getFeatures({
                        serviceName: sensor.serviceName,
    					layer: "0",
                        query: {
                            "where": sensor.whereClause,
                            "outFields": "OBJECTID,id",
                            "returnGeometry":"false",
                            "f":"json"
                        }
                    }).then(function(response){
                        console.log("Existing (ID,OID) pairs:");
                        for(var i= 0; i < response.features.length; i++){
                            oids[response.features[i].attributes.id]=response.features[i].attributes.OBJECTID;
                            console.log(response.features[i].attributes.id+" => "+response.features[i].attributes.OBJECTID);
                        }
                    },function(e){
                        console.log("Error: ", e);
                    });
            }
        }
    },function(e){
        console.log("Error: ", e);
    });
};


/************************************************************
 *
 *   UTILS: some tiny functions
 *
 ************************************************************/

// Method to transform sensor datetime format to ArcGIS datetime, or return the now timestamp if no sensor datetime is present
var parseDate = function(timeInstant){
    var date;
    if(timeInstant){
        timeInstant = timeInstant.replace("-","/").replace("-","/").replace("T"," ");
        date = new Date(timeInstant);
    }else{
        date = new Date();//now
    }
    return date.getTime();
};

// Method to transform sensor datetime format to ArcGIS datetime
var logger = function (txt, msg){
    if(config.debug){
        console.log("\n\n"+txt, msg);
    }
};